#!/usr/bin/env node
/**
 * serve — 本地卡片站。静态文件 + 四个接口。
 * 默认只绑 127.0.0.1，端口 4780 起，被占就往后找。
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, getBundle, recordReview, dbPath, getState, applyEvent, ensureColumn, rowToCard, adjustRung } from "./db.mjs";
import { decide } from "./whisper.mjs";
import { generateExample, generateScenarioExample } from "./teach.mjs";
import { item as kbItem } from "./kb.mjs";
import { next as guideNext, path3 as guidePath, gaps as guideGaps, recordGuide, logExposure } from "./guide.mjs";
import { locate } from "./where.mjs";
import { judgeHealth } from "./judge.mjs";
import { scanHistory, listHistory, importGenerated as importHistory, recordProcessed, autoScanDue, markAutoScan, historySettings, sessionScanEnabled, setSessionScan } from "./history.mjs";
import { loadConfig, maskKey, check } from "./llm.mjs";
import { enqueueSeed, seedItem, expandSeed, pruneSeeds, seedPromptFor, importSeedData } from "./seed.mjs";
import { weekly, markSeen } from "./weekly.mjs";
import { ensureKbMaps, kbItemFromLog, listKbLog, updateKbLog, deleteKbLog, addKbLog, syncCardsToKbLog, invalidateKbStamp } from "./kbmap.mjs";
import { EMBEDDING_PROVIDERS, publicEmbeddingConfig, testEmbedding } from "./embed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".ico": "image/x-icon"
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function openBrowser(url) {
  const cmd = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
  } catch {
    console.log(`请手动打开：${url}`);
  }
}

let pending = null;
let queue = [];
let lastPopAt = 0;
const QUEUE_FILE = path.join(ROOT, "data", "whisper-queue.json");
function loadQueue() {
  try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf8")); } catch { queue = []; }
}
function saveQueue() {
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue.slice(0, 50)));
  } catch {}
}

const MODES = ["极简", "精简", "完全"];
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    return { notifyMode: MODES.includes(raw.notifyMode) ? raw.notifyMode : "精简" };
  } catch { return { notifyMode: "精简" }; }
}
function saveSettings(patch) {
  const file = path.join(ROOT, "config.json");
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const next = { ...raw, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}
function mini(item) {
  return { id: item.id, tier: item.tier, score: item.score, reason: item.reason,
           title: item.card.title, shape: item.card.shape, ts: item.ts };
}

function pushSeed(item) {
  if (!item) return;
  if (pending) {
    queue.unshift(item);
    if (queue.length > 50) queue.length = 50;
    saveQueue();
  } else {
    pending = item;
    lastPopAt = Date.now();
  }
}

function cardCounts(db) {
  const total = db.prepare("SELECT COUNT(*) c FROM card WHERE status='active'").get().c;
  const unseen = db.prepare("SELECT COUNT(*) c FROM card WHERE status='active' AND seen_at=0").get().c;
  return { ok: true, total, unseen };
}

/** 设置页只回脱敏后的密钥；本地模型状态顺带给出，方便判断生成会走哪条路。 */
async function llmSettings() {
  const cfg = loadConfig();
  const local = await judgeHealth().catch(() => ({ enabled: false, up: false }));
  const hs = historySettings();
  return {
    ok: true,
    baseURL: cfg.baseURL,
    model: cfg.model,
    hasKey: !!cfg.apiKey,
    maskedKey: maskKey(cfg.apiKey),
    local: local,
    historyPriority: hs.priority,
    historyLookback: hs.lookback,
    hint: cfg.apiKey
      ? "历史补课使用这里填的 API；没填时才用本地模型。"
      : "没有 API key：本地模型在跑就用本地，否则直接调用 DSH 内置模型。"
  };
}

function slimCard(db, c) {
  const st = getState(db, c.conceptId);
  return {
    id: c.id, lane: c.lane, title: c.title, scene: c.scene, question: c.question,
    options: c.options, answerIndex: c.answerIndex, answer: c.answer, metaphor: c.metaphor,
    explain: c.explain, terms: c.terms, takeaway: c.takeaway, figure: c.figure,
    source: c.source, conceptId: c.conceptId, examples: c.examples || [], quiz: c.quiz || [],
    shape: c.shape || "concept", workflow: c.workflow || null,
    stage: st.state, mastery: st.s,
    rung: st.rung || 0, rungTypes: st.rung_types || []
  };
}

async function main() {
  const db = openDb(arg("--db", dbPath(ROOT)));
  const settings = loadSettings();
  loadQueue();
  pruneSeeds(db);
  ensureColumn(db, "card", "examples_json", "examples_json TEXT NOT NULL DEFAULT '[]'");
  // 本地知识缓存与知识地图：不依赖模型/网络，启动时补齐一次；签名变了下次请求再重建。
  try {
    const kb = await ensureKbMaps(db);
    if (kb.built) {
      console.log(`知识缓存 ${kb.entries || 0} 条 · 标签 ${kb.tags || 0} 个 · 来源文件 ${kb.files || 0} 个`);
    }
  } catch (e) {
    console.error("知识缓存初始化失败（不挡卡片站）:", e && e.message ? e.message : e);
  }

  /** 读地图 JSON；没有就让本地知识缓存现建一份（签名不变时不会重复算）。 */
  async function serveKbMapFile(res, file, missError) {
    try {
      await ensureKbMaps(db);
    } catch (e) {
      console.error("知识地图重建失败:", e && e.message ? e.message : e);
    }
    const f = path.join(ROOT, "data", file);
    if (!fs.existsSync(f)) return send(res, 404, JSON.stringify({ ok: false, error: missError, local: true }));
    return send(res, 200, fs.readFileSync(f));
  }
  let exampleBudget = 20;
  let port = Number(arg("--port", 4780));
  const host = arg("--host", "127.0.0.1");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const p = decodeURIComponent(url.pathname);
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-methods", "GET,HEAD,POST,OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("access-control-max-age", "600");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (p === "/api/bundle" && req.method === "GET") {
        const bundle = getBundle(db);
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
          bundle.stats.cardLimit = Number(cfg.cardLimit) || 50;
        } catch { bundle.stats.cardLimit = 50; }
        return send(res, 200, JSON.stringify(bundle));
      }
      if (p === "/api/card/status" && req.method === "GET") {
        return send(res, 200, JSON.stringify(cardCounts(db)));
      }
      if (p === "/api/card/seen" && req.method === "POST") {
        const b = await readBody(req);
        if (!b.cardId) return send(res, 400, JSON.stringify({ ok: false, error: "缺少 cardId" }));
        db.prepare("UPDATE card SET seen_at=? WHERE id=?").run(Date.now(), b.cardId);
        return send(res, 200, JSON.stringify(cardCounts(db)));
      }
      if (p === "/api/review" && req.method === "POST") {
        const b = await readBody(req);
        if (!b.cardId || !["got", "nope", "too-easy"].includes(b.action)) {
          return send(res, 400, JSON.stringify({ ok: false, error: "bad request" }));
        }
        recordReview(db, { cardId: b.cardId, action: b.action });
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      if (p === "/api/quiz" && req.method === "POST") {
        const b = await readBody(req);
        const row = db.prepare("SELECT quiz_json, concept_id FROM card WHERE id=?").get(b.cardId);
        if (!row) return send(res, 404, JSON.stringify({ ok: false, error: "no card" }));
        const quiz = JSON.parse(row.quiz_json || "[]");
        const item = quiz[b.quizIndex];
        if (!item) return send(res, 404, JSON.stringify({ ok: false, error: "no quiz" }));
        const correct = Number(b.picked) === Number(item.answerIndex);
        recordReview(db, { cardId: b.cardId, action: "quiz", quizIndex: b.quizIndex, picked: b.picked, correct });
        let st = null;
        if (row.concept_id) {
          st = applyEvent(db, row.concept_id, correct ? "correct" : "wrong", { type: item.kind || "recall" });
        }
        return send(res, 200, JSON.stringify({ ok: true, correct, stage: st && st.state, mastery: st && st.s }));
      }
      if (p === "/api/whisper/detect" && req.method === "POST") {
        const b = await readBody(req);
        if (!sessionScanEnabled(db, b.sessionId)) {
          return send(res, 200, JSON.stringify({ tier: "none", action: "none", reason: "该会话未开启扫描" }));
        }
        const d = await decide(db, { sessionId: b.sessionId, kind: b.kind || "error", text: b.text });
        if (b.dry === true) {
          return send(res, 200, JSON.stringify({
            ok: true, dry: true, tier: d.tier,
            card: d.card ? { id: d.card.id, title: d.card.title } : null,
            kb: d.kb ? { id: d.kb.id, title: d.kb.title, score: d.kb.score } : null,
            reason: d.reason, score: d.final || d.sim || 0
          }));
        }
        if (d.seed && d.seedText) {
          const seedMeta = { text: d.seedText, sessionId: b.sessionId || "", project: b.project || "" };
          if (!loadConfig().apiKey) {
            return send(res, 200, JSON.stringify({
              tier: "none", action: "none", reason: d.reason,
              seedPrompt: seedPromptFor(d.seedText), seedMeta
            }));
          }
          void enqueueSeed(db, seedMeta).then((seed) => {
            if (seed && !seed.needsDsh) pushSeed(seedItem(seed, seedMeta));
          }).catch(() => {});
        }
        let item = null;
        if (d.kb) {
          item = {
            id: Math.random().toString(36).slice(2, 9), tier: d.tier, score: d.final,
            reason: d.reason,
            card: { id: d.kb.id, shape: "kb", title: d.kb.title, summary: d.kb.summary,
                    scene: d.kb.preview, source: d.kb.meta && d.kb.meta.source, kbId: d.kb.id },
            concept: null, ts: Date.now()
          };
        } else if (d.tier === "pop" || d.tier === "badge") {
          if (d.card.conceptId) logExposure(d.card.conceptId);
          const row = db.prepare("SELECT * FROM card WHERE id=?").get(d.card.id);
          item = {
            id: Math.random().toString(36).slice(2, 9), tier: d.tier, score: d.final, reason: d.reason,
            card: slimCard(db, rowToCard(row)),
            concept: d.concept ? { name: d.concept.name, desc: d.concept.desc } : null,
            ts: Date.now()
          };
        }
        const mode = settings.notifyMode;
        let action = d.tier;
        if (item) {
          if (action === "pop") {
            if (mode === "极简" && d.stage !== "unknown") action = "queue";
            else if (mode === "精简" && Date.now() - lastPopAt < 10 * 60 * 1000) action = "queue";
          } else if (action === "badge" && mode !== "完全") action = "queue";
        }
        if (item && action === "queue") {
          queue.unshift({ ...item, tier: d.tier });
          if (queue.length > 50) queue.length = 50;
          saveQueue();
        } else if (item) {
          pending = { ...item, tier: action === "badge" ? "badge" : "pop" };
          lastPopAt = Date.now();
        }
        return send(res, 200, JSON.stringify({
          tier: d.tier, action, queued: queue.length,
          reason: d.reason, score: d.final || 0
        }));
      }
      if (p === "/api/guide/next" && req.method === "GET") {
        const cid = new URL(req.url, "http://x").searchParams.get("conceptId");
        const g = guideNext(db, cid);
        if (g) recordGuide(g.concept.id, g.kind);
        return send(res, 200, JSON.stringify({ ok: true, suggestion: g }));
      }
      if (p === "/api/guide/path" && req.method === "GET") {
        const cid = new URL(req.url, "http://x").searchParams.get("conceptId");
        return send(res, 200, JSON.stringify({ ok: true, steps: guidePath(db, cid) }));
      }
      if (p === "/api/guide/gaps" && req.method === "GET") {
        return send(res, 200, JSON.stringify({ ok: true, gaps: guideGaps(db) }));
      }
      if (p === "/api/guide/card" && req.method === "GET") {
        const id = new URL(req.url, "http://x").searchParams.get("id");
        const row = db.prepare("SELECT * FROM card WHERE id=?").get(id);
        if (!row) return send(res, 404, JSON.stringify({ ok: false }));
        return send(res, 200, JSON.stringify({ ok: true, card: slimCard(db, rowToCard(row)) }));
      }
      if (p === "/api/card/rung" && req.method === "POST") {
        const b = await readBody(req);
        const row = db.prepare("SELECT concept_id FROM card WHERE id=?").get(b.cardId);
        if (!row) return send(res, 404, JSON.stringify({ ok: false, error: "no card" }));
        if (!["up", "down"].includes(b.action)) return send(res, 400, JSON.stringify({ ok: false, error: "bad action" }));
        const r = adjustRung(db, row.concept_id, b.action === "up" ? 1 : -1);
        return send(res, 200, JSON.stringify({ ok: true, rung: r.rung, conceptId: row.concept_id }));
      }
      if (p === "/api/locate" && req.method === "GET") {
        const sp = new URL(req.url, "http://x").searchParams;
        const r = await locate({
          session: sp.get("session") || "",
          seq: sp.get("seq") || 0,
          quote: sp.get("quote") || ""
        });
        return send(res, r.ok ? 200 : 404, JSON.stringify(r));
      }
      if (p === "/api/weekly" && req.method === "GET") {
        const force = new URL(req.url, "http://x").searchParams.get("force") === "1";
        return send(res, 200, JSON.stringify(weekly(db, { force })));
      }
      if (p === "/api/weekly/seen" && req.method === "POST") {
        const b = await readBody(req);
        markSeen(b.week);
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      if (p === "/api/kb/map") {
        return serveKbMapFile(res, "kb-map.json", "no map data");
      }
      if (p === "/api/kb/code-map") {
        return serveKbMapFile(res, "kb-code-map.json", "no code-map data");
      }
      if (p === "/api/whisper/queue" && req.method === "GET") {
        return send(res, 200, JSON.stringify({ mode: settings.notifyMode, items: queue.map(mini) }));
      }
      if (p === "/api/whisper/next" && req.method === "POST") {
        if (pending) {
          if (pending.card.shape !== "seed") recordProcessed(db, pending, "next");
          pending = null;
        }
        const item = queue.shift();
        saveQueue();
        if (!item) return send(res, 200, JSON.stringify({ item: null }));
        pending = item; lastPopAt = Date.now();
        return send(res, 200, JSON.stringify({ item }));
      }
      if (p === "/api/settings" && req.method === "GET") {
        return send(res, 200, JSON.stringify({ ok: true, notifyMode: settings.notifyMode, modes: MODES }));
      }
      if (p === "/api/settings" && req.method === "POST") {
        const b = await readBody(req);
        if (!MODES.includes(b.notifyMode)) return send(res, 400, JSON.stringify({ ok: false }));
        settings.notifyMode = b.notifyMode;
        saveSettings({ notifyMode: b.notifyMode });
        return send(res, 200, JSON.stringify({ ok: true, notifyMode: settings.notifyMode }));
      }
      if (p === "/api/whisper/pending" && req.method === "GET") {
        const alive = pending && Date.now() - pending.ts < 150000;
        if (!alive && pending) {                 // 没及时看：退回待看，而不是丢掉
          queue.unshift(pending); pending = null; saveQueue();
        }
        return send(res, 200, JSON.stringify({ item: alive ? pending : null }));
      }
      if (p === "/api/seed/import" && req.method === "POST") {
        const b = await readBody(req);
        const seed = importSeedData(db, b.text, b.meta);
        if (!seed) return send(res, 422, JSON.stringify({ ok: false, error: "种子卡校验未通过或已在冷却中" }));
        pushSeed(seedItem(seed, b.meta || {}));
        return send(res, 200, JSON.stringify({ ok: true, seed }));
      }
      if (p === "/api/seed/expand" && req.method === "POST") {
        const b = await readBody(req);
        if (!b.seedId) return send(res, 400, JSON.stringify({ ok: false, error: "缺少 seedId" }));
        const r = await expandSeed(db, b.seedId);
        if (!r.ok) return send(res, 422, JSON.stringify(r));
        const row = db.prepare("SELECT * FROM card WHERE id=?").get(r.card.id);
        if (!row) return send(res, 500, JSON.stringify({ ok: false, error: "完整卡没有落库" }));
        const item = {
          id: r.card.id, tier: "pop", score: 0.8, reason: "种子卡展开",
          card: slimCard(db, rowToCard(row)), concept: null, ts: Date.now()
        };
        pending = item;
        lastPopAt = Date.now();
        return send(res, 200, JSON.stringify({ ok: true, item, engine: r.engine }));
      }
      if (p === "/api/whisper/ack" && req.method === "POST") {
        const b = await readBody(req);
        if (pending && b.id === pending.id) {
          if (pending.card.shape === "seed") {
            db.prepare("UPDATE seed SET status='dropped' WHERE id=?").run(pending.card.id);
            pending = null;
            return send(res, 200, JSON.stringify({ ok: true }));
          }
          // 知识库条目没有卡片行，确认动作只清 pending，不写复习记录
          if (pending.card.shape !== "kb") {
            if (b.action === "nope") recordReview(db, { cardId: pending.card.id, action: "nope" });
            if (b.action === "got") recordReview(db, { cardId: pending.card.id, action: "got" });
            if (b.action === "too-easy") recordReview(db, { cardId: pending.card.id, action: "too-easy" });
          }
          recordProcessed(db, pending, b.action);
          pending = null;
          return send(res, 200, JSON.stringify({ ok: true }));
        }
        return send(res, 404, JSON.stringify({ ok: false, error: "no such pending" }));
      }
      if (p === "/api/history/list" && req.method === "GET") {
        const limit = Number(new URL(req.url, "http://x").searchParams.get("limit")) || 40;
        return send(res, 200, JSON.stringify({ ok: true, items: listHistory(db, { limit }) }));
      }
      if (p === "/api/session/scan" && req.method === "GET") {
        const sessionId = new URL(req.url, "http://x").searchParams.get("sessionId") || "";
        return send(res, 200, JSON.stringify({ ok: true, sessionId, enabled: sessionScanEnabled(db, sessionId) }));
      }
      if (p === "/api/session/scan" && req.method === "POST") {
        const b = await readBody(req);
        if (!b.sessionId) return send(res, 400, JSON.stringify({ ok: false, error: "缺少 sessionId" }));
        const r = setSessionScan(db, b.sessionId, b.enabled !== false);
        return send(res, 200, JSON.stringify(r));
      }
      if (p === "/api/history/scan" && req.method === "POST") {
        const b = await readBody(req);
        if (b.auto && !autoScanDue(db)) {
          return send(res, 200, JSON.stringify({ ok: true, skipped: true, reason: "12 小时内已经补过历史" }));
        }
        const r = await scanHistory(db, {
          limit: b.limit,
          before: b.before,
          requireKb: b.requireKb !== false,
          dry: b.dry === true
        });
        if (!r.needsDsh) markAutoScan(db);
        return send(res, 200, JSON.stringify(r));
      }
      if (p === "/api/history/import" && req.method === "POST") {
        const b = await readBody(req);
        const r = await importHistory(db, b.items, { scanId: b.scanId });
        markAutoScan(db);
        return send(res, 200, JSON.stringify(r));
      }
      if (p === "/api/history/mark-auto" && req.method === "POST") {
        markAutoScan(db);
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      if (p === "/api/settings/llm" && req.method === "GET") {
        return send(res, 200, JSON.stringify(await llmSettings()));
      }
      if (p === "/api/settings/llm" && req.method === "POST") {
        const b = await readBody(req);
        if (b.baseURL != null && !/^https?:\/\//i.test(String(b.baseURL))) {
          return send(res, 400, JSON.stringify({ ok: false, error: "API 地址要以 http:// 或 https:// 开头" }));
        }
        const patch = {};
        if (b.baseURL != null) patch.baseURL = String(b.baseURL).replace(/\/+$/, "");
        if (b.model != null) patch.model = String(b.model).trim();
        if (b.historyPriority != null) {
          const p = Array.isArray(b.historyPriority) ? b.historyPriority : [];
          if (p.length !== 3 || new Set(p).size !== 3 || p.some((x) => !["api", "local", "dsh"].includes(x))) {
            return send(res, 400, JSON.stringify({ ok: false, error: "模型优先级必须是 api/local/dsh 各一次" }));
          }
          patch.historyPriority = p;
        }
        if (b.historyLookback != null) {
          const raw = b.historyLookback || {};
          if (!["turns", "days"].includes(raw.mode)) {
            return send(res, 400, JSON.stringify({ ok: false, error: "回溯方式只能是 turns 或 days" }));
          }
          const turns = Number(raw.turns);
          const days = Number(raw.days);
          if (!Number.isFinite(turns) || turns < 1 || turns > 50 || !Number.isFinite(days) || days < 1 || days > 365) {
            return send(res, 400, JSON.stringify({ ok: false, error: "回溯轮数 1–50，天数 1–365" }));
          }
          patch.historyLookback = { mode: raw.mode, turns, days };
        }
        if (b.apiKey != null && String(b.apiKey).trim()) patch.apiKey = String(b.apiKey).trim();
        if (b.clearKey) patch.apiKey = "";
        saveSettings(patch);
        return send(res, 200, JSON.stringify(await llmSettings()));
      }
      if (p === "/api/settings/llm/test" && req.method === "POST") {
        const cfg = loadConfig();
        const local = await judgeHealth().catch(() => ({ up: false }));
        if (!cfg.apiKey) {
          return send(res, 200, JSON.stringify({
            ok: false,
            error: local.up && local.modelPresent
              ? "API 未填；历史生成会优先用本地模型 " + local.model
              : "API 未填，本地模型也没起；历史生成会直接调用 DSH 内置模型"
          }));
        }
        try {
          const r = await check(cfg);
          return send(res, 200, JSON.stringify({ ok: true, ms: r.ms, model: r.model, reply: r.reply }));
        } catch (e) {
          return send(res, 200, JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      }
      if (p === "/api/settings/embedding" && req.method === "GET") {
        return send(res, 200, JSON.stringify(publicEmbeddingConfig()));
      }
      if (p === "/api/settings/embedding" && req.method === "POST") {
        const b = await readBody(req);
        const allowed = new Set(EMBEDDING_PROVIDERS.map((x) => x.id));
        const prevRaw = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")); } catch { return {}; } })();
        const emb = { ...(prevRaw.embedding && typeof prevRaw.embedding === "object" ? prevRaw.embedding : {}) };
        if (b.provider != null) {
          if (!allowed.has(String(b.provider))) return send(res, 400, JSON.stringify({ ok: false, error: "未知的 embedding 提供商" }));
          emb.provider = String(b.provider);
        }
        if (b.enabled != null) emb.enabled = !!b.enabled;
        if (b.baseURL != null) {
          const baseURL = String(b.baseURL).trim().replace(/\/+$/, "");
          if (baseURL && !/^https?:\/\//i.test(baseURL)) {
            return send(res, 400, JSON.stringify({ ok: false, error: "API 地址要以 http:// 或 https:// 开头" }));
          }
          emb.baseURL = baseURL;
        }
        if (b.model != null) emb.model = String(b.model).trim().slice(0, 120);
        if (b.apiKey != null && String(b.apiKey).trim()) emb.apiKey = String(b.apiKey).trim();
        if (b.clearKey) emb.apiKey = "";
        if (b.dim != null) {
          const dim = Number(b.dim);
          if (!Number.isFinite(dim) || dim < 0 || dim > 4096) return send(res, 400, JSON.stringify({ ok: false, error: "dim 要在 0–4096" }));
          emb.dim = dim;
        }
        if (b.timeoutMs != null) {
          const n = Number(b.timeoutMs);
          if (!Number.isFinite(n) || n < 1500 || n > 60000) return send(res, 400, JSON.stringify({ ok: false, error: "超时要在 1500–60000ms" }));
          emb.timeoutMs = n;
        }
        if (b.batchSize != null) {
          const n = Number(b.batchSize);
          if (!Number.isFinite(n) || n < 1 || n > 128) return send(res, 400, JSON.stringify({ ok: false, error: "批量大小要在 1–128" }));
          emb.batchSize = n;
        }
        if (b.maxEntries != null) {
          const n = Number(b.maxEntries);
          if (!Number.isFinite(n) || n < 1 || n > 5000) return send(res, 400, JSON.stringify({ ok: false, error: "条目上限要在 1–5000" }));
          emb.maxEntries = n;
        }
        if (b.useForSearch != null) emb.useForSearch = !!b.useForSearch;
        saveSettings({ embedding: emb });
        invalidateKbStamp();
        // 配置变了就后台重建语义地图；不阻塞保存（可能要走远程接口）。
        ensureKbMaps(db, { force: true }).catch((e) => console.error("embedding 重建失败:", e && e.message ? e.message : e));
        return send(res, 200, JSON.stringify(publicEmbeddingConfig()));
      }
      if (p === "/api/settings/embedding/test" && req.method === "POST") {
        const b = await readBody(req).catch(() => ({}));
        const r = await testEmbedding(b || {});
        return send(res, 200, JSON.stringify(r));
      }
      if (p === "/api/settings/embedding/rebuild" && req.method === "POST") {
        invalidateKbStamp();
        const counts = await ensureKbMaps(db, { force: true });
        let embedding = null;
        try {
          const map = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "kb-map.json"), "utf8"));
          embedding = map.embedding || null;
        } catch { /* 没有就算了 */ }
        return send(res, 200, JSON.stringify({ ok: true, maps: counts, embedding }));
      }
      if (p === "/api/card/learn" && req.method === "POST") {
        const b = await readBody(req);
        const row = db.prepare("SELECT concept_id FROM card WHERE id=?").get(b.cardId);
        if (!row) return send(res, 404, JSON.stringify({ ok: false }));
        recordReview(db, { cardId: b.cardId, action: "taught" });
        const st = applyEvent(db, row.concept_id, "taught");
        return send(res, 200, JSON.stringify({ ok: true, stage: st.state, mastery: st.s }));
      }
      if (p === "/api/card/known" && req.method === "POST") {
        const b = await readBody(req);
        const row = db.prepare("SELECT concept_id FROM card WHERE id=?").get(b.cardId);
        if (!row) return send(res, 404, JSON.stringify({ ok: false }));
        const st = applyEvent(db, row.concept_id, "self-claim");
        return send(res, 200, JSON.stringify({ ok: true, stage: st.state, mastery: st.s }));
      }
      if (p === "/api/card/example" && req.method === "POST") {
        const b = await readBody(req);
        if (exampleBudget <= 0) return send(res, 429, JSON.stringify({ ok: false, error: "今天的例子额度用完了" }));
        const row = db.prepare("SELECT * FROM card WHERE id=?").get(b.cardId);
        if (!row) return send(res, 404, JSON.stringify({ ok: false, error: "no card" }));
        const card = {
          id: row.id, conceptId: row.concept_id, title: row.title, explain: row.explain,
          metaphor: row.metaphor, takeaway: row.takeaway,
          terms: JSON.parse(row.terms_json || "[]"),
          examples: JSON.parse(row.examples_json || "[]")
        };
        try {
          const ex = await generateExample(card, b.kind === "advanced" ? "advanced" : "again");
          const list = card.examples.concat([ex]);
          const trimmed = list.length > 4 ? [list[list.length - 1]].concat(list.filter((x) => x.level === 1).slice(-3)) : list;
          db.prepare("UPDATE card SET examples_json=? WHERE id=?").run(JSON.stringify(trimmed.slice(0, 4)), card.id);
          if (pending && pending.card.id === card.id) pending.card.examples = trimmed.slice(0, 4);
          exampleBudget -= 1;
          return send(res, 200, JSON.stringify({ ok: true, example: ex, remaining: exampleBudget }));
        } catch (e) {
          return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      }
      if (p === "/api/card/scenario" && req.method === "POST") {
        const b = await readBody(req);
        if (exampleBudget <= 0) return send(res, 429, JSON.stringify({ ok: false, error: "今天的例子额度用完了" }));
        const row = db.prepare("SELECT * FROM card WHERE id=?").get(b.cardId);
        if (!row || !row.workflow_json) return send(res, 404, JSON.stringify({ ok: false, error: "no workflow card" }));
        const wf = JSON.parse(row.workflow_json);
        const idx = Number(b.index);
        const sc = (wf.scenarios || [])[idx];
        if (!sc) return send(res, 404, JSON.stringify({ ok: false, error: "no scenario" }));
        try {
          const ex = await generateScenarioExample({ title: row.title, workflow: wf }, sc);
          wf.scenarios[idx].example = ex;
          db.prepare("UPDATE card SET workflow_json=? WHERE id=?").run(JSON.stringify(wf), row.id);
          if (pending && pending.card.id === row.id) pending.card.workflow = wf;
          exampleBudget -= 1;
          return send(res, 200, JSON.stringify({ ok: true, example: ex, remaining: exampleBudget }));
        } catch (e) {
          return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }));
        }
      }
      if (p === "/api/kb/tags") {
        return serveKbMapFile(res, "kb-tags.json", "no tags data");
      }
      if (p === "/api/kb/log" && req.method === "GET") {
        const sp = url.searchParams;
        const list = listKbLog(db, {
          q: sp.get("q") || "", status: sp.get("status") || "all",
          tag: sp.get("tag") || "", project: sp.get("project") || "",
          limit: sp.get("limit"), offset: sp.get("offset")
        });
        return send(res, 200, JSON.stringify(list));
      }
      if (p === "/api/kb/log/update" && req.method === "POST") {
        const b = await readBody(req);
        const r = updateKbLog(db, b);
        return send(res, r.ok ? 200 : (r.error === "没有这条缓存" ? 404 : 400), JSON.stringify(r));
      }
      if (p === "/api/kb/log/delete" && req.method === "POST") {
        const b = await readBody(req);
        const r = deleteKbLog(db, b.id);
        return send(res, r.ok ? 200 : 404, JSON.stringify(r));
      }
      if (p === "/api/kb/log/add" && req.method === "POST") {
        const b = await readBody(req);
        const r = addKbLog(db, b);
        return send(res, r.ok ? 200 : 400, JSON.stringify(r));
      }
      if (p === "/api/kb/log/sync" && req.method === "POST") {
        const synced = syncCardsToKbLog(db);
        const maps = await ensureKbMaps(db, { force: true }).catch(() => ({}));
        return send(res, 200, JSON.stringify({ ok: true, ...synced, maps }));
      }
      if (p.startsWith("/api/kb/item")) {
        const id = new URL(req.url, "http://x").searchParams.get("id");
        const remote = await kbItem(id).catch(() => null);
        if (remote) return send(res, 200, JSON.stringify(remote));
        const local = kbItemFromLog(db, id);
        return send(res, local ? 200 : 404, JSON.stringify(local || { ok: false }));
      }
      if (p === "/api/health") {
        const judge = await judgeHealth().catch(() => ({ enabled: true, up: false }));
        return send(res, 200, JSON.stringify({ ok: true, remainingExamples: exampleBudget, judge }));
      }

      // static
      let file = p === "/" ? "/index.html" : p;
      const abs = path.join(PUBLIC, file);
      if (!abs.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        // SPA fallback
        const idx = path.join(PUBLIC, "index.html");
        if (fs.existsSync(idx)) return send(res, 200, fs.readFileSync(idx), MIME[".html"]);
        return send(res, 404, "not found", "text/plain");
      }
      return send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs)] || "application/octet-stream");
    } catch (e) {
      return send(res, 500, JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  });

  const tryListen = (n, left) => {
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE" && left > 0) return tryListen(n + 1, left - 1);
      console.error(e);
      process.exit(1);
    });
    server.listen(n, host, () => {
      const b = getBundle(db);
      const url = `http://${host}:${n}`;
      console.log(`学习小助手 v1  →  ${url}`);
      console.log(`卡片 ${b.stats.cards} 张 · 概念 ${b.stats.concepts} 个 · ${JSON.stringify(b.stats.byLane)}`);
      if (!b.stats.cards) console.log("提示：还没有卡片，先跑 node src/ingest.mjs");
      if (process.argv.includes("--open")) openBrowser(url);
    });
  };
  tryListen(port, 20);
}

main().catch((e) => { console.error(e); process.exit(1); });
