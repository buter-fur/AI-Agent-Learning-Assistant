/**
 * history — 从旧会话补课。
 *
 * 实时旁听只做「已有卡片的命中」；这里负责把启用插件之前的历史会话扫一遍，
 * 找出还没被现有卡片/知识库覆盖的开发片段，交给模型做成新卡。
 *
 * 设计边界：
 *   - 只在旧会话上工作（默认排除最近 5 分钟仍在写的会话），避免和实时链路抢同一段。
 *   - 先对比卡片与知识库，命中过的就不再生成。
 *   - 生成引擎按「本地模型 → 设置里的 API → DSH 内置模型」降级；DSH 那一步由 Host 半边执行。
 *   - 入库前仍走与 ingest 相同的校验：选项数量、引文逐字命中、卡数上限。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonlSync, listSessionFiles, ensureDir, truncate } from "./util.mjs";
import { scanSessions } from "./scan.mjs";
import { packetFor } from "./packet.mjs";
import { SYSTEM, buildUser } from "./prompt.mjs";
import { matchCard } from "./whisper.mjs";
import { search as kbSearch, thresholds as kbThresholds } from "./kb.mjs";
import { loadConfig, chat, parseJsonLoose } from "./llm.mjs";
import { judgeConfig } from "./judge.mjs";
import { upsertCards, upsertConcepts, upsertEdges } from "./db.mjs";
import { logCardEntry } from "./kbmap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMITS = { title: 18, scene: 80, question: 40, answer: 40, metaphor: 80, explain: 140, takeaway: 50, query: 40 };
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 8;
const AUTO_INTERVAL = 12 * 3600 * 1000;
const PRIORITY_KINDS = ["api", "local", "dsh"];
const DEFAULT_PRIORITY = ["api", "local", "dsh"];
const DEFAULT_LOOKBACK = { mode: "turns", turns: 8, days: 7 };
/* 角色扮演/文件整理类会话不是开发学习素材；只靠规则分容易把故事大纲也选进来。 */
const NON_DEV_PROJECT = /^(文件|工作区|SillyTavern)/i;
const CODE_FILE = /\.(js|mjs|cjs|ts|tsx|jsx|py|css|html|json|sh|swift|java|kt)$/i;

/** 当前待生成的候选（候选 id → 提示词和原文元信息），供 Host 回传结果时对上。 */
const pending = new Map();

const len = (s) => [...String(s || "")].length;
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

function config() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")); } catch { return {}; }
}

/** 模型优先级：三档各一次；坏配置回退默认 API → 本地 → DSH。 */
export function normalizePriority(value) {
  if (!Array.isArray(value) || value.length !== PRIORITY_KINDS.length) return [...DEFAULT_PRIORITY];
  const seen = new Set();
  for (const item of value) {
    if (!PRIORITY_KINDS.includes(item) || seen.has(item)) return [...DEFAULT_PRIORITY];
    seen.add(item);
  }
  return [...value];
}

/** 回溯范围：默认近 8 轮；也可以改成最近 N 天。 */
export function normalizeLookback(value) {
  const raw = value && typeof value === "object" ? value : {};
  const mode = raw.mode === "days" ? "days" : "turns";
  const turns = Math.max(1, Math.min(50, Number(raw.turns) || DEFAULT_LOOKBACK.turns));
  const days = Math.max(1, Math.min(365, Number(raw.days) || DEFAULT_LOOKBACK.days));
  return { mode, turns, days };
}

export function historySettings() {
  const raw = config();
  return {
    priority: normalizePriority(raw.historyPriority),
    lookback: normalizeLookback(raw.historyLookback)
  };
}

export function historyMeta(db, key) {
  try { return db.prepare("SELECT value FROM history_meta WHERE key=?").get(key)?.value ?? null; } catch { return null; }
}

export function setHistoryMeta(db, key, value) {
  db.prepare("INSERT OR REPLACE INTO history_meta(key,value) VALUES(?,?)").run(key, String(value));
}

/** 没有 session_scan 行 = 默认开启，保持旧版“所有会话都旁听”的行为。 */
export function sessionScanEnabled(db, sessionId) {
  if (!sessionId) return true;
  const row = db.prepare("SELECT enabled FROM session_scan WHERE session_id=?").get(String(sessionId));
  return !row || Number(row.enabled) !== 0;
}

export function setSessionScan(db, sessionId, enabled) {
  if (!sessionId) return { ok: false, error: "缺少 sessionId" };
  db.prepare(`INSERT INTO session_scan(session_id,enabled,updated_at) VALUES(?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`)
    .run(String(sessionId), enabled ? 1 : 0, Date.now());
  return { ok: true, sessionId: String(sessionId), enabled: !!enabled };
}

/** 把一轮候选压成一段可比较的文本。 */
export function candidateText(c) {
  const parts = [];
  for (const u of c.userText || []) parts.push(u.text);
  for (const a of c.assistantText || []) parts.push(a.text);
  for (const e of c.errors || []) parts.push(e.text);
  for (const e of c.edits || []) parts.push(e.new || e.old || "");
  for (const m of c.memories || []) parts.push(m.content);
  return parts.join("\n").trim();
}

function bigrams(s) {
  const t = String(s || "").replace(/[^\u4e00-\u9fa5a-z0-9]/gi, "").toLowerCase();
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function overlap(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

/** 引文允许模型用「…」省略中间一段，但每一段仍必须逐字出现在会话原文里。 */
function quoteMatches(corpus, text) {
  const c = norm(corpus);
  const q = norm(text);
  if (!q) return false;
  if (c.includes(q)) return true;
  const parts = String(text).split(/…|\.\.\./).map((p) => norm(p)).filter((p) => p.length >= 6);
  return parts.length > 1 && parts.every((p) => c.includes(p));
}

function historyCovered(db, c) {
  const text = candidateText(c);
  if (text.length < 12) return true;
  // 卡片已经讲过的点不再重复做卡。
  const hit = matchCard(db, { text, sessionId: c.sessionId });
  if (hit && hit.sim >= 0.55) return true;
  return false;
}

async function kbCovered(text) {
  try {
    const items = await kbSearch(text, 3);
    const top = items && items[0];
    return !!(top && Number(top.score) >= kbThresholds().pop);
  } catch {
    return false;
  }
}

/** 读取一个会话的全文，用于引文逐字校验。 */
async function sessionCorpus(file) {
  if (!file) return "";
  const rows = await readJsonlSync(file);
  const out = [];
  const pushBlocks = (content) => {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b && typeof b.text === "string") out.push(b.text);
      if (b && typeof b.arguments === "string") out.push(b.arguments);
    }
  };
  for (const r of rows) {
    if (r.type === "user/message" || r.type === "assistant/message" || r.type === "tool/result") {
      if (r.data && r.data.message) pushBlocks(r.data.message.content);
      if (r.data) pushBlocks(r.data.content);
    }
    if (r.type === "tool/call" && r.data && typeof r.data.arguments === "string") out.push(r.data.arguments);
    if (r.type === "compaction/summary" && r.data) out.push(JSON.stringify(r.data));
  }
  return out.join("\n");
}

/** 找出这一轮值得补卡、且尚未被卡片/知识库覆盖的旧会话片段。 */
export async function prepareCandidates(db, { limit = DEFAULT_LIMIT, before = Date.now() - 5 * 60 * 1000, requireKb = true, lookback = historySettings().lookback } = {}) {
  const n = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
  const scanned = await scanSessions({ minScore: 3, cap: 700, excludeSelf: true, before });
  const rows = scanned.kept || [];
  const done = new Set(db.prepare("SELECT session_id || '#' || turn AS k FROM history_scan").all().map((r) => r.k));
  const chosen = [];
  let skipped = 0;
  let kbChecked = 0;

  for (const c of rows) {
    if (chosen.length >= n) break;
    if (!c.sessionId || c.turn == null) continue;
    if (!sessionScanEnabled(db, c.sessionId)) { skipped += 1; continue; }
    if (lookback.mode === "turns" && c.turnMax != null && c.turnMax - c.turn >= lookback.turns) { skipped += 1; continue; }
    if (lookback.mode === "days" && c.time && c.time < Date.now() - lookback.days * 86400000) { skipped += 1; continue; }
    if (NON_DEV_PROJECT.test(String(c.project || ""))) { skipped += 1; continue; }
    if (c.lane === "syntax" && !(c.edits || []).some((e) => CODE_FILE.test(String(e.file || "")))) { skipped += 1; continue; }
    if (done.has(c.sessionId + "#" + c.turn)) { skipped += 1; continue; }
    if (before && c.time && c.time > before) { skipped += 1; continue; }
    if (historyCovered(db, c)) { skipped += 1; continue; }
    if (requireKb && kbChecked < 40) {
      kbChecked += 1;
      const covered = await kbCovered(candidateText(c));
      if (covered) { skipped += 1; continue; }
    }
    const text = candidateText(c);
    if (chosen.some((x) => overlap(candidateText(x), text) >= 0.62)) { skipped += 1; continue; }
    chosen.push(c);
  }

  const scanId = "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const candidates = chosen.map((c) => {
    let packet = packetFor(c, false);
    if (packet.length > 7000) packet = packetFor(c, true);
    if (packet.length > 8200) packet = packet.slice(0, 8200) + "\n\n…（已截断）";
    const user = buildUser(packet);
    const meta = {
      id: c.id, sessionId: c.sessionId, sessionFile: c.sessionFile, turn: c.turn,
      project: c.project, time: c.time, timeText: c.timeText,
      seqStart: c.seqStart, seqEnd: c.seqEnd
    };
    pending.set(scanId + "\u0000" + c.id, { meta, system: SYSTEM, user });
    return { id: c.id, system: SYSTEM, user, meta };
  });

  return {
    ok: true,
    scanId,
    scanned: rows.length,
    skipped,
    candidates,
    at: Date.now()
  };
}

/** 按用户设置的三档优先级选择；dsh 固定交给 Host。 */
async function chooseEngine(priority = DEFAULT_PRIORITY) {
  for (const kind of normalizePriority(priority)) {
    if (kind === "api") {
      const api = loadConfig();
      if (api.apiKey) {
        return { kind: "api", label: "设置里的 API", cfg: { ...api, timeoutMs: Math.max(60000, api.timeoutMs || 0), maxTokens: 4096 } };
      }
      continue;
    }
    if (kind === "local") {
      const local = judgeConfig();
      if (!local || local.enabled === false) continue;
      const base = String(local.baseURL || "http://127.0.0.1:11434").replace(/\/+$/, "");
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 900);
        const res = await fetch(base + "/api/tags", { signal: ctrl.signal });
        clearTimeout(timer);
        const data = await res.json().catch(() => ({}));
        const names = (data.models || []).map((m) => m.name).filter(Boolean);
        if (res.ok && names.length) {
          return {
            kind: "local",
            label: "本地模型",
            cfg: {
              baseURL: base + "/v1",
              model: names.includes(local.model) ? local.model : names[0],
              apiKey: "ollama",
              timeoutMs: 300000,
              retries: 0,
              jsonMode: false,
              temperature: 0.35,
              maxTokens: 4096
            }
          };
        }
      } catch {
        /* 本地没起：看下一档 */
      }
      continue;
    }
    if (kind === "dsh") return { kind: "none", label: "DSH 内置模型" };
  }
  return { kind: "none", label: "DSH 内置模型" };
}

async function runOne(engine, candidate) {
  const res = await chat(
    [{ role: "system", content: candidate.system }, { role: "user", content: candidate.user }],
    engine.cfg
  );
  if (!String(res.content || "").trim()) throw new Error("模型只输出了思考，没有正文");
  return res.content;
}

/** 模型经常忘写「我不知道」；这里补上并压回 2–3 个选项，避免好卡被格式问题丢掉。 */
function repairOptions(card) {
  if (!card || card.shape === "workflow" || !Array.isArray(card.options)) return;
  const ai = Number(card.answerIndex);
  const hasUnknown = card.options.includes("我不知道");
  if (!hasUnknown) card.options.push("我不知道");
  if (card.options.length > 3) {
    const answer = Number.isInteger(ai) && ai >= 0 && ai < card.options.length ? card.options[ai] : card.options[0];
    const distractor = card.options.find((x, i) => i !== ai && x !== "我不知道") || "其他";
    card.options = [answer, distractor, "我不知道"];
    card.answerIndex = 0;
  }
}

/** 校验一张历史卡；不通过就只记录原因，不写库。 */
export function validateCard(card, candidate, corpus) {
  const reasons = [];
  if (!card || typeof card !== "object") return ["卡片不是对象"];
  if (!card.id || !card.lane || !card.conceptId) reasons.push("缺少 id/lane/conceptId");
  if (!["mechanism", "syntax", "algorithm", "judgment"].includes(card.lane)) reasons.push(`lane 非法: ${card.lane}`);
  for (const [k, max] of Object.entries(LIMITS)) {
    if (card[k] && len(card[k]) > max) reasons.push(`${k} ${len(card[k])}>${max}`);
  }
  const isWorkflow = card.shape === "workflow";
  if (!isWorkflow) {
    const total = ["title", "scene", "question", "metaphor", "explain", "takeaway"].reduce((n, k) => n + len(card[k]), 0);
    if (total > 320) reasons.push(`总字数 ${total}>320`);
    if (!Array.isArray(card.options) || card.options.length < 2 || card.options.length > 3) reasons.push("options 必须 2–3 个");
    else if (!card.options.includes("我不知道")) reasons.push("options 缺少「我不知道」");
    if (!Number.isInteger(card.answerIndex) || card.answerIndex < 0 || card.answerIndex >= (card.options || []).length) reasons.push("answerIndex 越界");
    else if ((card.options || [])[card.answerIndex] === "我不知道") reasons.push("answerIndex 不能指向「我不知道」");
    if (!Array.isArray(card.terms) || card.terms.length > 3) reasons.push("terms 必须 ≤3");
    if (!Array.isArray(card.quiz) || card.quiz.length < 1) reasons.push("quiz 至少 1 道");
  } else {
    const wf = card.workflow || {};
    if (!Array.isArray(wf.steps) || wf.steps.length < 3) reasons.push("工作流卡缺少 steps（≥3）");
    if (!Array.isArray(wf.decisions) || wf.decisions.length < 3) reasons.push("工作流卡缺少 decisions（≥3）");
    if (!Array.isArray(wf.scenarios) || wf.scenarios.length < 3) reasons.push("工作流卡缺少 scenarios（≥3）");
  }
  const quotes = (card.source && card.source.quotes) || [];
  if (!quotes.length && !isWorkflow) reasons.push("source.quotes 至少 1 条");
  if (corpus && reasons.length === 0) {
    for (const q of quotes) {
      if (!q || !q.text) { reasons.push("空引文"); continue; }
      if (!quoteMatches(corpus, q.text)) reasons.push(`引文未命中原文: 「${truncate(q.text, 28)}」`);
    }
  }
  return reasons;
}

function slimCard(card) {
  return {
    id: card.id, lane: card.lane, title: card.title, scene: card.scene || "",
    question: card.question || "", options: card.options || [], answerIndex: card.answerIndex || 0,
    answer: card.answer || "", metaphor: card.metaphor || "", explain: card.explain || "",
    terms: card.terms || [], takeaway: card.takeaway || "", figure: card.figure || null,
    source: card.source || {}, conceptId: card.conceptId, shape: card.shape || "concept",
    workflow: card.workflow || null, stage: "unknown", mastery: 0, rung: 0
  };
}

function activePoolSize(db) {
  const known = new Set(db.prepare("SELECT concept_id FROM concept_state WHERE state='known'").all().map((r) => r.concept_id));
  return db.prepare("SELECT id, concept_id FROM card WHERE status='active'").all()
    .filter((r) => !known.has(r.concept_id)).length;
}

/** 把 Host 回传的模型原始文本校验、入库，并记进历史卡片列表。 */
export async function importGenerated(db, items, { scanId } = {}) {
  const accepted = [];
  const rejected = [];
  const concepts = [];
  const edges = [];
  let limitHit = false;
  const limit = Number(config().cardLimit) || 50;
  let pool = activePoolSize(db);
  const corpusCache = new Map();

  for (const item of items || []) {
    const key = scanId ? scanId + "\u0000" + item.candidateId : item.candidateId;
    const entry = pending.get(key);
    if (!entry) { rejected.push({ candidateId: item.candidateId, reasons: ["找不到候选上下文"] }); continue; }
    const { meta, system, user } = entry;
    let parsed;
    try {
      parsed = parseJsonLoose(item.text);
    } catch (e) {
      rejected.push({ candidateId: item.candidateId, reasons: ["模型返回不是 JSON: " + String(e.message || e)] });
      pending.delete(key);
      db.prepare("INSERT OR REPLACE INTO history_scan(session_id,turn,scanned_at) VALUES(?,?,?)")
        .run(meta.sessionId, Number(meta.turn) || 0, Date.now());
      continue;
    }

    let corpus = corpusCache.get(meta.sessionFile);
    if (corpus == null) {
      try { corpus = await sessionCorpus(meta.sessionFile); } catch { corpus = ""; }
      corpusCache.set(meta.sessionFile, corpus);
    }

    const conceptsIn = Array.isArray(parsed.concepts) ? parsed.concepts : [];
    for (const c of conceptsIn) concepts.push(c);
    if (Array.isArray(parsed.edges)) edges.push(...parsed.edges);

    for (const raw of (Array.isArray(parsed.cards) ? parsed.cards : [])) {
      const card = { ...raw };
      card.options = Array.isArray(raw.options) ? [...raw.options] : raw.options;
      repairOptions(card);
      card.source = { ...(card.source || {}) };
      if (!card.source.project) card.source.project = meta.project;
      if (!card.source.session) card.source.session = meta.sessionId;
      if (!card.source.time) card.source.time = meta.timeText || meta.time;
      card.source.origin = "history";
      card.source.candidate = item.candidateId;

      const reasons = validateCard(card, meta, corpus);
      if (reasons.length) { rejected.push({ candidateId: item.candidateId, card: card.id, reasons }); continue; }
      if (db.prepare("SELECT id FROM card WHERE id=?").get(card.id)) {
        rejected.push({ candidateId: item.candidateId, card: card.id, reasons: ["卡片 id 已存在"] });
        continue;
      }
      if (pool >= limit) {
        limitHit = true;
        // 卡片池到上限不等于知识作废：把这条已验证的知识落进本地知识缓存（不受 50 张限制）。
        try { logCardEntry(db, card, { origin: "history", status: "active" }); } catch { /* 缓存写失败不挡补卡 */ }
        rejected.push({ candidateId: item.candidateId, card: card.id, reasons: [`未学卡片上限 ${limit}，先淘汰旧卡再补历史`] });
        continue;
      }

      if (!concepts.some((c) => c.id === card.conceptId)) {
        concepts.push({ id: card.conceptId, name: card.conceptId, domain: "未归类", problem: "", lane: card.lane, desc: "", level: 1 });
      }
      upsertCards(db, [{ ...card, status: "active", createdAt: Date.now() }]);
      pool += 1;
      accepted.push(card);
      db.prepare(`INSERT OR REPLACE INTO history(id,kind,card_id,title,summary,lane,action,card_json,session_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        "gen:" + card.id, "generated", card.id, card.title,
        card.takeaway || card.scene || "", card.lane || "", "",
        JSON.stringify(slimCard(card)), meta.sessionId, Date.now()
      );
    }

    pending.delete(key);
    db.prepare("INSERT OR REPLACE INTO history_scan(session_id,turn,scanned_at) VALUES(?,?,?)")
      .run(meta.sessionId, Number(meta.turn) || 0, Date.now());
  }

  const conceptIds = new Set(concepts.map((c) => c.id));
  if (concepts.length) upsertConcepts(db, concepts);
  if (edges.length) {
    const valid = edges.filter((e) => e && conceptIds.has(e.from) && conceptIds.has(e.to)
      && ["prereq", "cause", "contrast", "same"].includes(e.kind));
    if (valid.length) upsertEdges(db, valid);
  }
  return {
    ok: true,
    scanId,
    generated: accepted.length,
    rejected: rejected.length,
    reasons: rejected.slice(0, 8),
    limitHit,
    cards: accepted.map((c) => ({ id: c.id, title: c.title, lane: c.lane }))
  };
}

/** 扫描 + 生成。需要 Host 的 DSH 模型时返回 needsDsh 和候选提示词。 */
export async function scanHistory(db, { limit = DEFAULT_LIMIT, before, requireKb = true, dry = false } = {}) {
  const settings = historySettings();
  const prepared = await prepareCandidates(db, { limit, before, requireKb, lookback: settings.lookback });
  if (!prepared.candidates.length) {
    return { ok: true, generated: 0, scanned: prepared.scanned, skipped: prepared.skipped, candidates: [], message: "没有新的旧会话素材" };
  }
  if (dry) {
    return { ok: true, dry: true, scanned: prepared.scanned, skipped: prepared.skipped, candidates: prepared.candidates };
  }
  const engine = await chooseEngine(settings.priority);
  if (engine.kind === "none") {
    return {
      ok: true,
      needsDsh: true,
      scanId: prepared.scanId,
      engine: engine.label,
      scanned: prepared.scanned,
      skipped: prepared.skipped,
      candidates: prepared.candidates.map((c) => ({ id: c.id, system: c.system, user: c.user, meta: c.meta }))
    };
  }

  const items = [];
  const errors = [];
  for (const c of prepared.candidates) {
    try {
      const text = await runOne(engine, c);
      items.push({ candidateId: c.id, text });
    } catch (e) {
      errors.push({ candidateId: c.id, error: String(e.message || e) });
    }
  }
  const imported = await importGenerated(db, items, { scanId: prepared.scanId });
  return {
    ...imported,
    scanId: prepared.scanId,
    engine: engine.label,
    scanned: prepared.scanned,
    skipped: prepared.skipped,
    modelErrors: errors.slice(0, 4)
  };
}

/** 历史卡片列表：补生成的卡 + 已处理过的实时旁听。 */
export function listHistory(db, { limit = 40 } = {}) {
  const rows = db.prepare("SELECT * FROM history ORDER BY created_at DESC LIMIT ?").all(Math.max(1, Math.min(100, Number(limit) || 40)));
  return rows.map((r) => {
    let card = {};
    try { card = JSON.parse(r.card_json || "{}"); } catch { card = {}; }
    return {
      id: r.id, kind: r.kind, cardId: r.card_id, title: r.title, summary: r.summary,
      lane: r.lane, action: r.action || "", sessionId: r.session_id,
      createdAt: r.created_at, card
    };
  });
}

/** 实时旁听被确认/取下一张后，把这条归到历史里。 */
export function recordProcessed(db, item, action) {
  if (!item || !item.card) return;
  const card = item.card;
  db.prepare(`INSERT OR REPLACE INTO history(id,kind,card_id,title,summary,lane,action,card_json,session_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    "proc:" + (item.id || Math.random().toString(36).slice(2)),
    "processed", card.id || "", card.title || "未命名",
    card.takeaway || card.scene || card.summary || "", card.lane || "", action || "",
    JSON.stringify(card), (card.source && card.source.session) || "", Date.now()
  );
}

/** 自动补课节流：12 小时内只跑一次。 */
export function autoScanDue(db) {
  const last = Number(historyMeta(db, "lastAutoScan") || 0);
  return !last || Date.now() - last > AUTO_INTERVAL;
}

export function markAutoScan(db) {
  setHistoryMeta(db, "lastAutoScan", String(Date.now()));
}

export { DEFAULT_LIMIT, MAX_LIMIT };
