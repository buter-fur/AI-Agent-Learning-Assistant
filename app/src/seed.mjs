/**
 * seed — 主动路径的“种子卡”。
 *
 * 卡片/知识库都没命中时，不直接生成完整卡，只用一个小请求提取
 * 标题 + 一句结论 + 逐字引文，先弹一张可展开的前置卡；用户点「展开细讲」
 * 才走完整制卡和引文校验。这样主动路径的常态成本只有一次小模型调用。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat, loadConfig, parseJsonLoose } from "./llm.mjs";
import { judgeConfig } from "./judge.mjs";
import { SYSTEM, SCHEMA_HINT } from "./prompt.mjs";
import { validateCard, historyMeta, setHistoryMeta } from "./history.mjs";
import { upsertCards, upsertConcepts, upsertEdges } from "./db.mjs";
import { logSeedPending, promoteSeedLog } from "./kbmap.mjs";
import { fmtTime, truncate } from "./util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_COOLDOWN = 10 * 60 * 1000;
const SEED_TTL = 7 * 24 * 3600 * 1000;
const LANES = ["mechanism", "syntax", "algorithm", "judgment"];
let inFlight = null;

function config() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")); } catch { return {}; }
}

const len = (s) => [...String(s || "")].length;
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

/** 引文允许模型用「…」省略，但每一段仍要逐字命中。 */
function quoteMatches(text, quote) {
  const c = norm(text);
  const q = norm(quote);
  if (!q) return false;
  if (c.includes(q)) return true;
  const parts = String(quote).split(/…|\.\.\./).map((p) => norm(p)).filter((p) => p.length >= 6);
  return parts.length > 1 && parts.every((p) => c.includes(p));
}

function digest(text) {
  return crypto.createHash("sha1").update(norm(text)).digest("hex");
}

function excerpt(text, n = 140) {
  return truncate(String(text || "").replace(/\s+/g, " ").trim(), n);
}

export function seedPromptFor(text) {
  const clip = String(text || "").slice(0, 1500);
  return `你是「学习小助手」的知识点嗅探器。下面是一段真实的开发对话，请只提取 1 个最值得记成学习卡的知识点。
只输出 JSON，形如 {"title":"≤18字","takeaway":"≤50字","quote":"逐字原文","lane":"mechanism|syntax|algorithm|judgment"}。
规则：
- title 用「当时的问题」做标题，不用知识点名。
- takeaway 写成「以后看到 X 先想到 Y」。
- quote 必须逐字来自素材，找不到就输出 {"title":""}。
- 没有值得记的点就输出 {"title":""}，不要凑数。

素材：
${clip}`;
}

/** Host 用 DSH 模型生成后回传原始文本；这里统一解析/校验/入库。 */
export function importSeedData(db, raw, meta) {
  if (!meta || !meta.text || !seedDue(db, meta.text)) return null;
  let data;
  try { data = validSeed(parseJsonLoose(raw), meta.text); } catch { return null; }
  return data ? insertSeed(db, data, meta) : null;
}

/** 主动路径是否值得做一张种子卡：同会话冷却 + 去重。 */
export function seedDue(db, text) {
  if (!text || text.length < 30) return false;
  const last = Number(historyMeta(db, "lastSeedAt") || 0);
  if (Date.now() - last < SEED_COOLDOWN) return false;
  const hash = digest(text);
  const row = db.prepare("SELECT id FROM seed WHERE hash=?").get(hash);
  return !row;
}

function validSeed(data, text) {
  if (!data || typeof data !== "object") return null;
  const title = String(data.title || "").trim();
  if (!title) return null;
  const takeaway = String(data.takeaway || "").trim();
  const quote = String(data.quote || "").trim();
  const lane = LANES.includes(data.lane) ? data.lane : "judgment";
  if (len(title) > 18 || len(takeaway) > 50 || !quote || !quoteMatches(text, quote)) return null;
  return { title, takeaway, quote, lane };
}

function insertSeed(db, data, meta) {
  const now = Date.now();
  const id = "seed-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  db.prepare(`INSERT INTO seed(id,hash,title,takeaway,quote,text,lane,project,session_id,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, digest(meta.text), data.title, data.takeaway, data.quote,
    meta.text.slice(0, 4000), data.lane, meta.project || "",
    meta.sessionId || "", "new", now
  );
  setHistoryMeta(db, "lastSeedAt", now);
  const seed = {
    id, title: data.title, takeaway: data.takeaway, quote: data.quote,
    text: meta.text.slice(0, 4000), lane: data.lane,
    project: meta.project || "", sessionId: meta.sessionId || "", createdAt: now
  };
  // 种子也是知识：先以 pending 存进本地知识缓存，卡片池满也不丢；展开后再升级。
  try { logSeedPending(db, seed); } catch { /* 缓存写失败不挡种子卡 */ }
  return seed;
}

/** 只生成种子；没有 API key 时返回 needsDsh 和提示词，交给 Host 兜底。 */
export function enqueueSeed(db, meta) {
  if (!seedDue(db, meta.text)) return Promise.resolve(null);
  const prompt = seedPromptFor(meta.text);
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return Promise.resolve({ ok: false, needsDsh: true, prompt, text: meta.text, meta });
  }
  if (inFlight) return Promise.resolve(null);
  inFlight = (async () => {
    const res = await chat(
      [{ role: "user", content: prompt }],
      { ...cfg, maxTokens: 320, temperature: 0.2, timeoutMs: 20000 },
      { json: true, maxTokens: 320, temperature: 0.2 }
    );
    const data = validSeed(parseJsonLoose(res.content), meta.text);
    if (!data) return null;
    return insertSeed(db, data, meta);
  })().catch(() => null).finally(() => { inFlight = null; });
  return inFlight;
}

/** 把种子加工成面板能直接显示的卡片。 */
export function seedItem(seed, extra = {}) {
  return {
    id: seed.id,
    tier: "pop",
    score: 0.5,
    reason: "主动发现新知识点",
    why: "现有卡片和知识库都没覆盖这个新知识点，先给你一张种子卡。",
    card: {
      id: seed.id,
      shape: "seed",
      lane: seed.lane,
      title: seed.title,
      scene: excerpt(seed.text, 160),
      takeaway: seed.takeaway,
      source: {
        project: seed.project || extra.project || "",
        session: seed.sessionId || extra.sessionId || "",
        time: fmtTime(seed.createdAt),
        quotes: [{ who: "assistant", text: seed.quote }],
        origin: "seed"
      },
      seenAt: 0
    },
    concept: null,
    ts: Date.now()
  };
}

function activePoolSize(db) {
  const known = new Set(db.prepare("SELECT concept_id FROM concept_state WHERE state='known'").all().map((r) => r.concept_id));
  return db.prepare("SELECT id, concept_id FROM card WHERE status='active'").all()
    .filter((r) => !known.has(r.concept_id)).length;
}

function engineForExpand() {
  const api = loadConfig();
  if (api.apiKey) return { label: "设置里的 API", cfg: { ...api, maxTokens: 4096, timeoutMs: Math.max(60000, api.timeoutMs || 0) } };
  const local = judgeConfig();
  if (local && local.enabled !== false) {
    const base = String(local.baseURL || "http://127.0.0.1:11434").replace(/\/+$/, "");
    return {
      label: "本地模型",
      cfg: {
        baseURL: base + "/v1",
        model: local.model,
        apiKey: "ollama",
        timeoutMs: 300000,
        retries: 0,
        jsonMode: false,
        temperature: 0.35,
        maxTokens: 4096
      }
    };
  }
  return null;
}

/** 用户点「展开细讲」：用现有完整制卡契约，校验通过后替换成正式卡。 */
export async function expandSeed(db, seedId) {
  const seed = db.prepare("SELECT * FROM seed WHERE id=? AND status='new'").get(seedId);
  if (!seed) return { ok: false, error: "种子卡不存在或已经展开" };
  const engine = engineForExpand();
  if (!engine) return { ok: false, error: "没有 API key，也没有本地模型；先补一个再展开" };

  const candidate = {
    id: seed.id, lane: seed.lane, project: seed.project || "现场",
    time: seed.created_at, timeText: fmtTime(seed.created_at),
    signals: ["proactive-seed"], score: 1,
    userText: [], assistantText: [{ text: seed.text }],
    errors: [], edits: [], decisions: [], memories: []
  };
  const material = String(seed.text || "").slice(0, 3000);
  const user = `下面是一张已经选定的种子卡，请把它扩成一张完整学习卡。\n\n` +
    `## 种子\n- 标题：${seed.title}\n- 结论：${seed.takeaway}\n- 引文：${seed.quote}\n- 线：${seed.lane}\n\n` +
    `## 现场素材（逐字，可引用）\n${material}\n\n` +
    `标题保持「当时的问题」；选项必须 2–3 个并包含「我不知道」；引文必须逐字来自上面的现场素材。\n\n${SCHEMA_HINT}`;

  let parsed;
  try {
    const res = await chat(
      [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
      engine.cfg,
      { maxTokens: 4096 }
    );
    parsed = parseJsonLoose(res.content);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
  if (!cards.length) return { ok: false, error: "模型没有产出完整卡" };
  const limit = Number(config().cardLimit) || 50;
  if (activePoolSize(db) >= limit) {
    try { logSeedPending(db, seed); } catch { /* 已有 pending 条目也无妨 */ }
    return { ok: false, error: `未学卡片上限 ${limit}，先淘汰旧卡再展开` };
  }

  const concepts = Array.isArray(parsed.concepts) ? parsed.concepts : [];
  const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
  let chosen = null;
  const rejects = [];
  for (const raw of cards) {
    const card = { ...raw };
    card.source = { ...(card.source || {}) };
    card.source.project = seed.project || "现场";
    card.source.session = seed.session_id || "";
    card.source.time = fmtTime(seed.created_at);
    card.source.origin = "seed";
    card.source.seed = seed.id;
    if (!card.id) card.id = "card-" + seed.id;
    if (db.prepare("SELECT id FROM card WHERE id=?").get(card.id)) card.id = card.id + "-" + Date.now().toString(36);
    const reasons = validateCard(card, candidate, seed.text);
    if (reasons.length) { rejects.push({ card: card.id, reasons }); continue; }
    chosen = card;
    break;
  }
  if (!chosen) {
    return { ok: false, error: "完整卡没有通过校验", reasons: rejects.slice(0, 4) };
  }
  if (!concepts.some((c) => c.id === chosen.conceptId)) {
    concepts.push({ id: chosen.conceptId, name: chosen.conceptId, domain: "未归类", problem: "", lane: chosen.lane, desc: "", level: 1 });
  }
  upsertConcepts(db, concepts);
  upsertCards(db, [{ ...chosen, status: "active", createdAt: Date.now() }]);
  if (edges.length) {
    const ids = new Set(concepts.map((c) => c.id));
    const valid = edges.filter((e) => e && ids.has(e.from) && ids.has(e.to) && ["prereq", "cause", "contrast", "same"].includes(e.kind));
    if (valid.length) upsertEdges(db, valid);
  }
  db.prepare("UPDATE seed SET status='expanded' WHERE id=?").run(seed.id);
  // pending 缓存条目升级为正式知识条目（代码地图/标签网络立刻能看到）。
  try { promoteSeedLog(db, seed, chosen); } catch { /* 缓存升级失败不挡展开 */ }
  return { ok: true, card: chosen, engine: engine.label };
}

/** 清掉很久没展开的种子，避免表越积越大。 */
export function pruneSeeds(db) {
  db.prepare("DELETE FROM seed WHERE status='new' AND created_at < ?").run(Date.now() - SEED_TTL);
}
