#!/usr/bin/env node
/**
 * kbmap — 轻量知识缓存（本地知识库替身），不依赖任何模型。
 *
 * 为什么要有它：知识地图原先只读 data/kb-tags.json / kb-code-map.json / kb-map.json，
 * 这三个文件由仓库外的知识库管线生成（Chroma + embedding 模型）；没装本地模型的用户
 * 永远拿不到数据。这里换一条路：
 *
 *   1. kb_log 表：专门存知识条目，不受「50 张卡」上限约束；卡片只是它的一个来源。
 *   2. 标签：用 standards/tag-map.json 的受控词表 + 规则做确定性归类，零成本。
 *   3. 代码地图：从卡片引文回到 DSH 会话日志，找同轮次的 write/edit 工具调用拿来源文件。
 *   4. 语义地图：中文字符 bigram TF-IDF + PCA 降到二维，零依赖、零网络。
 *   5. 检索：同一份缓存上做词表加权的关键词覆盖打分，替代 embedding 检索的最低档兜底。
 *
 * 生成物仍是原来那三个 JSON，前端不用改数据格式；将来接回 Chroma 知识库时可以直接覆盖。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSessionFiles, readJsonlSync, textOfEvent, ensureDir } from "./util.mjs";
import { openDb, dbPath } from "./db.mjs";
import { embedTexts, loadEmbeddingConfig, embeddingConfigured, cachedEmbedding } from "./embed.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const TAGS_FILE = path.join(DATA, "kb-tags.json");
const CODE_FILE = path.join(DATA, "kb-code-map.json");
const SEM_FILE = path.join(DATA, "kb-map.json");
const STAMP_FILE = path.join(DATA, "kb-map.stamp.json");

const LANES = ["mechanism", "syntax", "algorithm", "judgment"];
const PALETTE = ["#3d6b52", "#8a5a2b", "#3f5a78", "#b4432e", "#6b5b8a", "#2f6f6a", "#8a4b4b", "#5b6b3d", "#8b867d"];
const MAX_TAGS = 5;
const VEC_DIM = 64;

/* ── 标签词表：standards/tag-map.json + tag_rules.py 的规则 ────────── */

let vocabCache = null;

export function loadTagVocab() {
  if (vocabCache) return vocabCache;
  let canon = [];
  let map = {};
  const candidates = [
    path.join(ROOT, "..", "standards", "tag-map.json"),
    path.join(ROOT, "..", "tools", "tag-map.json"), // 老版本目录名，留着兼容
    path.join(DATA, "tag-map.json")
  ];
  for (const f of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, "utf8"));
      canon = Array.isArray(raw.canon) ? raw.canon.slice() : [];
      map = raw.map || {};
      if (canon.length) break;
    } catch { /* 试下一个 */ }
  }
  if (!canon.length) {
    canon = [
      "路径", "文件", "进程", "端口", "配置", "错误处理", "调试", "测试", "状态管理",
      "数据一致性", "数据迁移", "数据校验", "并发", "性能", "内存", "网络", "安全",
      "模型与接口", "提示词", "多智能体", "架构设计", "代码质量", "文档与规范",
      "环境与工具", "版本管理", "项目管理", "前端布局", "前端交互", "页面渲染"
    ];
  }
  const canonSet = new Set(canon);
  const exact = new Map();
  for (const [k, v] of Object.entries(map)) if (canonSet.has(v)) exact.set(k, v);
  vocabCache = { canon, canonSet, exact, rules: TAG_RULES };
  return vocabCache;
}

// 从 standards/tag_rules.py 的 RULES 移植（顺序即优先级；只在整段文本上扫一遍）。
const TAG_RULES = [
  [/色彩|ICC|色域|ΔE|校色/, "色彩管理"],
  [/macOS|macos|Mac\b|iOS|Widget|沙箱数据/, "macOS"],
  [/路径|目录|软链|Emoji/, "路径"],
  [/文件|剪贴板|Finder/, "文件"],
  [/权限|授权|entitlement|提权/, "权限"],
  [/沙箱|Sandbox/, "沙箱"],
  [/证书|签名/i, "签名与证书"],
  [/打包|发布|构建|PyInstaller|sys\.frozen/, "打包与发布"],
  [/依赖|npm|package|模块|exports|files/, "依赖与包管理"],
  [/端口|bind/i, "端口"],
  [/进程|线程|Host/, "进程"],
  [/网络|HTTP|curl|连通/, "网络"],
  [/错误|报错|异常|失败|Error|EPERM|OSError|ENOENT/, "错误处理"],
  [/调试|排查|测试|验证|断言|复测/, "测试"],
  [/状态|快照|指纹|stale|一致性|单调/, "状态管理"],
  [/渲染|画面|显示|绘制|颜色/, "页面渲染"],
  [/布局|CSS|flex|对齐|DOM|坐标|界面|UI/, "前端布局"],
  [/提示词|Prompt|prompt|World|角色卡|midjourney/, "提示词"],
  [/智能体|Multi-Agent|子代理|角色|职责/, "多智能体"],
  [/模型|API|接口|OAuth|认证|OpenAI|LLM/, "模型与接口"],
  [/计费|统计|成本|用量|分摊|推断|置信/, "计费与统计"],
  [/性能|帧|耗时|内存|leak|对象池/, "性能"],
  [/游戏|数值|平衡|难度|DPS/, "游戏开发"],
  [/并发|调度|路由|锚定/, "并发"],
  [/版本|迭代|发布节奏/, "版本管理"],
  [/项目|工作区|注册表|交付|文档|规范/, "项目管理"],
  [/安全|密钥|审计/, "安全"],
  [/跨平台|移植|Flutter|平台/, "跨平台"],
  [/数据|存储|迁移|校验|清洗|聚合|来源/, "数据存储"]
];

const LANE_FALLBACK_TAG = { mechanism: "机制", syntax: "语法", algorithm: "算法", judgment: "判断" };

/** 把任意文本/词归一成受控标签；返回去重后的数组（最多 5 个）。 */
export function deriveTags(input = {}) {
  const v = loadTagVocab();
  const out = [];
  const push = (t) => { if (t && v.canonSet.has(t) && !out.includes(t)) out.push(t); };
  const terms = Array.isArray(input.terms) ? input.terms : [];
  const tokens = [input.conceptName, input.conceptDomain, input.title]
    .concat(terms.map((t) => (typeof t === "string" ? t : t && t.term)))
    .filter(Boolean);
  for (const token of tokens) {
    const s = String(token).trim();
    if (!s) continue;
    if (v.exact.has(s)) push(v.exact.get(s));
    else if (v.canonSet.has(s)) push(s);
  }
  const full = [
    input.conceptName, input.conceptDomain, input.title, input.summary,
    input.text, terms.map((t) => (typeof t === "string" ? t : t && t.term)).join(" ")
  ].filter(Boolean).join(" ");
  if (full) {
    for (const [re, tag] of v.rules) {
      if (out.length >= MAX_TAGS) break;
      if (re.test(full)) push(tag);
    }
  }
  if (!out.length) {
    const lane = LANES.includes(input.lane) ? input.lane : "mechanism";
    const fallback = LANE_FALLBACK_TAG[lane];
    out.push(v.canonSet.has(fallback) ? fallback : "环境与工具");
  }
  return out.slice(0, MAX_TAGS);
}

/** 把用户输入的标签数组归一到词表内；未知词丢掉，重复合并。 */
export function canonizeTags(tags) {
  const v = loadTagVocab();
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const s = String(raw || "").trim();
    if (!s) continue;
    const mapped = v.exact.has(s) ? v.exact.get(s) : (v.canonSet.has(s) ? s : null);
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out.slice(0, MAX_TAGS);
}

/* ── 项目名 / 会话索引 ──────────────────────────────────────────── */

let sessionIndexCache = null;
let workspaceMapCache = null;

function safeParse(text, fallback) {
  try { const v = JSON.parse(text); return v == null ? fallback : v; } catch { return fallback; }
}

function loadWorkspaceMap() {
  if (workspaceMapCache) return workspaceMapCache;
  const map = new Map();
  const file = path.join(dshHome(), "storages", "workspace.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const ws of Object.values((raw.tables && raw.tables.workspaces) || {})) {
      const base = ws.path ? path.basename(ws.path) : "";
      const project = base || ws.title || "";
      for (const sid of ws.sessionIds || []) map.set(String(sid).replace(/^session-/, ""), project);
    }
  } catch { /* 没有 workspace.json 也不要紧 */ }
  workspaceMapCache = map;
  return map;
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function sessionIndex() {
  if (sessionIndexCache) return sessionIndexCache;
  const list = listSessionFiles().map((f) => ({
    ...f,
    id: path.basename(f.sessionDir).replace(/^session-/, "")
  }));
  sessionIndexCache = list;
  return list;
}

function findSessionFile(sessionRef) {
  const want = String(sessionRef || "").replace(/^session-/, "").trim();
  if (!want) return null;
  const list = sessionIndex();
  return list.find((f) => f.id === want) || list.find((f) => f.id.startsWith(want)) || list.find((f) => want.startsWith(f.id)) || null;
}

function saneProject(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.length > 24) return "";
  if (/[\\/\r\n]/.test(s)) return "";
  if (/^[A-Za-z]:?$/.test(s)) return ""; // "C" / "C:" 这种截断脏数据
  if (/^\d+$/.test(s)) return "";
  return s;
}

function projectOf(source, sessionId) {
  const sid = String(sessionId || (source && source.session) || "").replace(/^session-/, "");
  const ws = loadWorkspaceMap();
  if (sid && ws.has(sid)) return ws.get(sid);
  const direct = saneProject(source && source.project);
  if (direct) return direct;
  const hit = findSessionFile(sid);
  if (hit) {
    const decoded = decodeWorkspace(hit.workspaceDir);
    const base = path.basename(decoded.replace(/[\\/]+$/, ""));
    if (base) return base;
  }
  return "未标注";
}

/** "--E-programme--" → "E:/programme"；只用于最后一段兜底，不求完美。 */
function decodeWorkspace(name) {
  let s = String(name || "");
  if (s.startsWith("--")) s = s.slice(2);
  if (s.endsWith("--")) s = s.slice(0, -2);
  s = s.replace(/~(?:[0-9A-F]{4})/gi, (m) => String.fromCharCode(parseInt(m.slice(1), 16)));
  return s.replace(/-/g, "/");
}

function projectColor(project) {
  const s = String(project || "未标注");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/* ── 卡片 → kb_log 同步 ─────────────────────────────────────────── */

function cardLogId(cardId) {
  return "kb_" + String(cardId || "").replace(/^kb_/, "");
}

function entryFromCard(db, card, concepts) {
  // 兼容两种形状：SQLite 行（*_json 字符串）和生成流程里的原始卡片对象（数组/对象）。
  const source = card.source_json ? safeParse(card.source_json, {}) : (card.source || {});
  const concept = concepts.get(card.concept_id || card.conceptId) || {};
  const quotes = Array.isArray(source.quotes) ? source.quotes.filter((q) => q && q.text) : [];
  const terms = card.terms_json ? safeParse(card.terms_json, []) : (Array.isArray(card.terms) ? card.terms : []);
  const title = String(card.title || "").slice(0, 80);
  const summary = String(card.takeaway || card.question || "").slice(0, 160);
  const text = String(card.explain || card.scene || "").slice(0, 2000);
  const lane = LANES.includes(card.lane) ? card.lane : "mechanism";
  const cardId = card.id;
  const createdAt = Number(card.created_at || card.createdAt) || Date.now();
  const project = projectOf(source);
  const tags = deriveTags({
    title, summary, text, terms, lane,
    conceptName: concept.name || "", conceptDomain: concept.domain || ""
  });
  return {
    id: cardLogId(cardId),
    card_id: cardId,
    origin: source.origin === "history" ? "history" : (source.origin === "seed" ? "seed" : "card"),
    title, summary, text, lane, project,
    tags, quotes,
    source,
    status: "active",
    confidence: "A",
    created_at: createdAt,
    updated_at: createdAt
  };
}

const INSERT_LOG = `INSERT INTO kb_log(
  id, card_id, origin, title, summary, text, lane, project,
  tags_json, quotes_json, source_json, files_json, status, confidence, created_at, updated_at
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function insertLogRow(db, e, files = []) {
  db.prepare(INSERT_LOG).run(
    e.id, e.card_id || null, e.origin || "card", e.title || "", e.summary || "", e.text || "",
    e.lane || "mechanism", e.project || "", JSON.stringify(e.tags || []),
    JSON.stringify(e.quotes || []), JSON.stringify(e.source || {}),
    JSON.stringify(files), e.status || "active", e.confidence || "A",
    Number(e.created_at) || Date.now(), Number(e.updated_at) || Date.now()
  );
}

/**
 * 把卡片表里已有的知识条目补进 kb_log（只补缺，不覆盖用户改过的内容）。
 * 返回 {added, total}。
 */
export function syncCardsToKbLog(db) {
  const concepts = new Map(db.prepare("SELECT * FROM concept").all().map((c) => [c.id, c]));
  const rows = db.prepare("SELECT * FROM card").all();
  const have = new Set(db.prepare("SELECT id FROM kb_log").all().map((r) => r.id));
  const linked = new Set(db.prepare("SELECT card_id FROM kb_log WHERE card_id IS NOT NULL").all().map((r) => r.card_id));
  let added = 0;
  for (const card of rows) {
    if (linked.has(card.id) || have.has(cardLogId(card.id))) continue;
    insertLogRow(db, entryFromCard(db, card, concepts));
    added += 1;
  }
  const total = db.prepare("SELECT COUNT(*) c FROM kb_log").get().c;
  return { added, total };
}

/** 卡片上限拒绝掉的知识点也落进 kb_log，避免 50 张卡的天花板把知识扔掉。 */
export function logCardEntry(db, card, { origin = "history", status = "active", concepts } = {}) {
  if (!card || !card.id || !card.title) return null;
  const id = cardLogId(card.id);
  if (db.prepare("SELECT id FROM kb_log WHERE id=?").get(id)) return id;
  const cmap = concepts instanceof Map
    ? concepts
    : new Map(db.prepare("SELECT * FROM concept").all().map((c) => [c.id, c]));
  const entry = entryFromCard(db, card, cmap);
  if (origin) entry.origin = origin;
  if (status) entry.status = status;
  insertLogRow(db, entry, []);
  return id;
}

/** 种子卡：先以 pending 存进缓存，展开成完整卡后再升级为 active。 */
export function logSeedPending(db, seed) {
  const id = "kb_seed_" + seed.id;
  if (db.prepare("SELECT id FROM kb_log WHERE id=?").get(id)) return id;
  const tags = deriveTags({
    title: seed.title, summary: seed.takeaway, text: seed.text || "",
    lane: seed.lane, conceptName: seed.title
  });
  const createdAt = Number(seed.created_at || seed.createdAt) || Date.now();
  insertLogRow(db, {
    id, card_id: null, origin: "seed",
    title: String(seed.title || "").slice(0, 80),
    summary: String(seed.takeaway || "").slice(0, 160),
    text: String(seed.text || "").slice(0, 2000),
    lane: LANES.includes(seed.lane) ? seed.lane : "mechanism",
    project: saneProject(seed.project) || "未标注",
    tags,
    quotes: seed.quote ? [{ who: "现场", text: seed.quote }] : [],
    source: { project: seed.project || "", session: seed.session_id || seed.sessionId || "", time: "", origin: "seed" },
    status: "pending", confidence: "B",
    created_at: createdAt,
    updated_at: createdAt
  });
  return id;
}

/** 种子展开成功后，把 pending 条目升级成正式知识条目。 */
export function promoteSeedLog(db, seed, card) {
  const id = "kb_seed_" + seed.id;
  const row = db.prepare("SELECT * FROM kb_log WHERE id=?").get(id);
  if (!row) return null;
  const concepts = new Map(db.prepare("SELECT * FROM concept").all().map((c) => [c.id, c]));
  const entry = entryFromCard(db, {
    ...card,
    source_json: JSON.stringify(card.source || row.source_json)
  }, concepts);
  db.prepare(`UPDATE kb_log SET card_id=?, origin='seed', title=?, summary=?, text=?, lane=?, project=?,
    tags_json=?, quotes_json=?, source_json=?, status='active', confidence='A', updated_at=? WHERE id=?`).run(
    card.id, entry.title, entry.summary, entry.text, entry.lane, entry.project,
    JSON.stringify(entry.tags), JSON.stringify(entry.quotes), JSON.stringify(entry.source),
    Date.now(), id
  );
  return id;
}

/* ── 代码地图：从引文回到会话日志找来源文件 ─────────────────────── */

const FILE_EXT = /\.(?:mjs|cjs|js|jsx|ts|tsx|py|dart|json|md|css|html|htm|yml|yaml|sh|bat|ps1|cmd|txt|toml|rs|go|java|kt|swift|m|mm|c|cc|cpp|h|hpp)$/i;
const sessionRowsCache = new Map();
const SESSION_CACHE_MAX = 6;
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function sessionRows(sessionRef) {
  const hit = findSessionFile(sessionRef);
  if (!hit) return { file: null, rows: [] };
  const cached = sessionRowsCache.get(hit.file);
  if (cached) return { file: hit.file, rows: cached };
  let rows = [];
  try { rows = await readJsonlSync(hit.file); } catch { rows = []; }
  if (sessionRowsCache.size >= SESSION_CACHE_MAX) {
    const first = sessionRowsCache.keys().next().value;
    sessionRowsCache.delete(first);
  }
  sessionRowsCache.set(hit.file, rows);
  return { file: hit.file, rows };
}

function pathFromArgs(name, args) {
  if (!args || typeof args !== "object") return "";
  const direct = args.file_path || args.filePath || args.path || args.target;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (name === "pwsh" || name === "bash" || name === "shell") {
    const cmd = String(args.command || "");
    const m = cmd.match(/[A-Za-z]:\\[^"'<>|\r\n]+?\.[A-Za-z0-9]{1,5}/g) || cmd.match(/\/[^"'<>|\s]+?\.[A-Za-z0-9]{1,5}/g);
    if (m && m.length) {
      const withExt = m.find((p) => FILE_EXT.test(p.trim()));
      if (withExt) return withExt.trim();
    }
  }
  return "";
}

function buildCallIndex(rows) {
  const calls = [];
  const results = [];
  const messages = [];
  for (const ev of rows) {
    if (!ev || !ev.data) continue;
    if (ev.type === "tool/call") {
      let args = {};
      try { args = JSON.parse(ev.data.arguments || "{}"); } catch { args = {}; }
      const name = ev.data.name || "";
      calls.push({
        seq: ev.seq || 0, turn: ev.data.turn || 0, step: ev.data.step || 0, name,
        path: pathFromArgs(name, args),
        raw: norm(ev.data.arguments || ""),
        editLike: ["write", "edit", "apply_patch", "patch", "create_file"].includes(name) ||
          /write|edit|patch/i.test(name)
      });
    } else if (ev.type === "tool/result") {
      results.push({ seq: ev.seq || 0, turn: ev.data.turn || 0, step: ev.data.step || 0, text: norm(JSON.stringify(ev.data)) });
    } else if (ev.type === "user/message" || ev.type === "assistant/message" || ev.type === "system/message") {
      messages.push({ seq: ev.seq || 0, turn: ev.data.turn || 0, step: ev.data.step || 0, text: norm(textOfEvent(ev)) });
    }
  }
  return { calls, results, messages };
}

function nearestEditCall(calls, seq, turn) {
  let best = null;
  for (const c of calls) {
    if (!c.path || !c.editLike) continue;
    const d = Math.abs(c.seq - seq);
    const sameTurn = turn && c.turn === turn;
    if (d > 220 && !sameTurn) continue;
    if (!best || d < best.d) best = { call: c, d, sameTurn };
    else if (best && sameTurn && !best.sameTurn) best = { call: c, d, sameTurn };
  }
  return best ? best.call : null;
}

async function filesForEntry(entry) {
  const saved = entry.files_json ? safeParse(entry.files_json, []) : (Array.isArray(entry.files) ? entry.files : []);
  if (Array.isArray(saved) && saved.length) return saved.filter(Boolean).slice(0, 2);
  const source = entry.source_json ? safeParse(entry.source_json, {}) : (entry.source || {});
  const rawQuotes = entry.quotes_json ? safeParse(entry.quotes_json, []) : (entry.quotes || []);
  const quotes = rawQuotes.map((q) => norm(q && q.text)).filter((q) => q && q.length >= 6);
  if (!quotes.length) return [];
  const { rows } = await sessionRows(source.session);
  if (!rows.length) return [];
  const { calls, results, messages } = buildCallIndex(rows);
  const found = new Set();
  const add = (p) => {
    if (!p || !FILE_EXT.test(p)) return;
    if (found.size < 2) found.add(p);
  };
  for (const q of quotes) {
    // ① 引文出现在工具参数里：那条工具调用的文件就是来源
    for (const c of calls) {
      if (c.raw.includes(q)) { add(c.path); break; }
    }
    if (found.size) continue;
    // ② 引文出现在工具结果里：找同一步/紧邻的编辑调用
    const res = results.find((r) => r.text.includes(q));
    if (res) {
      const near = calls.filter((c) => c.editLike && c.path && c.seq <= res.seq + 2)
        .sort((a, b) => Math.abs(a.seq - res.seq) - Math.abs(b.seq - res.seq))[0];
      add(near ? near.path : "");
      const n2 = nearestEditCall(calls, res.seq, res.turn);
      add(n2 ? n2.path : "");
      if (found.size) continue;
    }
    // ③ 引文出现在消息里：找同一轮最近的一次编辑
    const msg = messages.find((m) => m.text.includes(q));
    if (msg) {
      const near = nearestEditCall(calls, msg.seq, msg.turn);
      add(near ? near.path : "");
    }
  }
  const result = [...found];
  try {
    dbPersistFiles(entry.id, result);
  } catch { /* 落库失败不影响本次生成 */ }
  return result;
}

// filesForEntry 里避免把 db 传一路，这里用模块级句柄（serve/CLI 初始化时设置）。
let activeDb = null;
function dbPersistFiles(id, files) {
  if (!activeDb || !id) return;
  // 只更新 files_json，不动 updated_at，避免签名抖动触发无限重建
  activeDb.prepare("UPDATE kb_log SET files_json=? WHERE id=?").run(JSON.stringify(files), id);
}

/* ── 语义地图：字符 bigram TF-IDF + PCA ─────────────────────────── */

const CJK_KEEP = /[^\u4e00-\u9fa5a-z0-9]/gi;
function bigrams(text) {
  const t = String(text || "").replace(CJK_KEEP, "").toLowerCase();
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

function hashToken(token, dim) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % dim;
}

function entryText(entry) {
  return [entry.title, entry.summary, entry.text].filter(Boolean).join("\n");
}

function buildVectors(entries) {
  const docs = entries.map((e) => bigrams(entryText(e)).slice(0, 400));
  const df = new Map();
  for (const toks of docs) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const n = entries.length;
  const vecs = docs.map((toks, idx) => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const v = new Array(VEC_DIM).fill(0);
    for (const [t, c] of tf) {
      const idf = Math.log(1 + n / (1 + (df.get(t) || 0)));
      v[hashToken(t, VEC_DIM)] += (1 + Math.log(c)) * idf;
    }
    let len = Math.hypot(...v);
    if (!len) {
      v[hashToken(entryText(entries[idx] || {}) || "x", VEC_DIM)] = 1;
      len = 1;
    }
    return v.map((x) => x / len);
  });
  return vecs;
}

function project2D(vecs) {
  const n = vecs.length;
  if (n < 2) return [[0.5, 0.5]];
  const D = vecs[0].length;
  const mean = new Array(D).fill(0);
  for (const v of vecs) for (let i = 0; i < D; i++) mean[i] += v[i] / n;
  const centered = vecs.map((v) => v.map((x, i) => x - mean[i]));
  const components = [];
  for (let k = 0; k < 2; k++) {
    let vec = new Array(D).fill(0).map((_, i) => Math.sin((i + 1) * (k + 1) * 1.7));
    let normLen = Math.hypot(...vec);
    vec = vec.map((x) => x / normLen);
    for (let it = 0; it < 120; it++) {
      const next = new Array(D).fill(0);
      for (const row of centered) {
        let dot = 0;
        for (let i = 0; i < D; i++) dot += row[i] * vec[i];
        for (let i = 0; i < D; i++) next[i] += dot * row[i];
      }
      for (const c of components) {
        let dot = 0;
        for (let i = 0; i < D; i++) dot += next[i] * c[i];
        for (let i = 0; i < D; i++) next[i] -= dot * c[i];
      }
      normLen = Math.hypot(...next) || 1;
      vec = next.map((x) => x / normLen);
    }
    components.push(vec);
  }
  const projected = centered.map((row) => [
    row.reduce((s, x, i) => s + x * components[0][i], 0),
    row.reduce((s, x, i) => s + x * components[1][i], 0)
  ]);
  const xs = projected.map((p) => p[0]);
  const ys = projected.map((p) => p[1]);
  const span = (arr) => {
    const min = Math.min(...arr), max = Math.max(...arr);
    return max - min > 1e-9 ? max - min : 0;
  };
  const sx = span(xs), sy = span(ys);
  return projected.map((p, i) => {
    let x = sx ? (p[0] - Math.min(...xs)) / sx : 0.5;
    let y = sy ? (p[1] - Math.min(...ys)) / sy : 0.5;
    if (n === 2) { x = i; y = 0.5; }
    return [0.08 + x * 0.84, 0.08 + y * 0.84];
  });
}

const V_STORE_DIM = 128;

/** 把任意维向量降到 ≤128 维（确定性随机投影），供前端算最近邻；余弦大致保持。 */
function projectVector(vec, dim = V_STORE_DIM) {
  if (!vec || !vec.length) return [];
  if (vec.length <= dim) return vec;
  const out = new Array(dim).fill(0);
  for (let j = 0; j < dim; j++) {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) {
      let h = Math.imul(i + 1, 2654435761) ^ Math.imul(j + 1, 2246822519);
      h = Math.imul(h ^ (h >>> 13), 3266489917);
      sum += vec[i] * ((h >>> 0) % 2 === 0 ? 1 : -1);
    }
    out[j] = sum;
  }
  const len = Math.hypot(...out) || 1;
  return out.map((x) => x / len);
}

/**
 * 语义地图：优先远程 embedding；没配或失败就回退本地 bigram TF-IDF。
 * 返回 {vecs, coords, embedding}，embedding.mode 会写进 kb-map.json 让前端如实展示。
 */
async function buildSemantic(entries) {
  const cfg = loadEmbeddingConfig();
  let mode = "local-tfidf";
  let info = { mode, reason: "远程 embedding 未启用（默认关闭）" };
  let vecs = null;
  if (cfg.enabled && !embeddingConfigured(cfg)) {
    info.reason = "已开启远程 embedding，但地址 / 模型 / API Key 没填全";
  } else if (embeddingConfigured(cfg)) {
    if (entries.length > cfg.maxEntries) {
      info.reason = `条目 ${entries.length} 条超过上限 maxEntries=${cfg.maxEntries}，为避免一次花太多 embedding 费用退回本地`;
    } else {
      try {
        const texts = entries.map((e) => entryText(e));
        const r = await embedTexts(texts, cfg);
        vecs = r.vectors;
        mode = "remote-embedding";
        info = {
          mode,
          provider: cfg.provider,
          model: r.model,
          dim: r.dim,
          apiCalls: r.apiCalls,
          cached: r.cached,
          useForSearch: cfg.useForSearch
        };
      } catch (e) {
        info = { mode: "local-tfidf", reason: "远程 embedding 不可用，已回退本地字面相似度：" + String(e && e.message || e) };
      }
    }
  }
  if (!vecs) vecs = buildVectors(entries);
  const coords = project2D(vecs);
  const stored = vecs.map((v) => projectVector(v));
  return { vecs: stored, coords, embedding: info };
}

/* ── 地图生成 ─────────────────────────────────────────────────── */

function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP_FILE, "utf8")); } catch { return null; }
}

function logSignature(db) {
  const r = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(updated_at),0) s, COALESCE(MAX(updated_at),0) m FROM kb_log").get();
  return `${r.c}:${r.s}:${r.m}`;
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

async function buildMaps(db) {
  const all = db.prepare("SELECT * FROM kb_log ORDER BY updated_at DESC").all();
  const active = all.filter((r) => r.status === "active");
  const entries = active.map((r) => {
    const e = {
      id: r.id, cardId: r.card_id || "", title: r.title, summary: r.summary, text: r.text, lane: r.lane,
      project: r.project || "未标注", status: r.status,
      tags: canonizeTags(safeParse(r.tags_json, [])),
      quotes: safeParse(r.quotes_json, []),
      source: safeParse(r.source_json, {}),
      updatedAt: Number(r.updated_at) || 0
    };
    if (!e.tags.length) {
      e.tags = deriveTags({ title: e.title, summary: e.summary, text: e.text, lane: e.lane, conceptName: e.title });
      db.prepare("UPDATE kb_log SET tags_json=? WHERE id=?").run(JSON.stringify(e.tags), e.id);
    }
    return e;
  });

  // 标签网络
  const tagMap = new Map();
  const byTag = {};
  for (const e of entries) {
    for (const t of e.tags) {
      if (!tagMap.has(t)) tagMap.set(t, { id: t, n: 0, projects: new Map(), entries: [] });
      const node = tagMap.get(t);
      node.n += 1;
      node.projects.set(e.project, (node.projects.get(e.project) || 0) + 1);
      node.entries.push({ id: e.id, title: e.title, cardId: e.cardId });
      (byTag[t] = byTag[t] || []).push({ id: e.id, title: e.title, cardId: e.cardId });
    }
  }
  const nodes = [...tagMap.values()].map((node) => {
    const p = [...node.projects.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { id: node.id, n: node.n, p, c: projectColor(p) };
  }).sort((a, b) => b.n - a.n);
  const pairCount = new Map();
  for (const e of entries) {
    const ts = [...new Set(e.tags)].sort();
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) {
        const k = ts[i] + "\u0000" + ts[j];
        pairCount.set(k, (pairCount.get(k) || 0) + 1);
      }
    }
  }
  const links = [...pairCount.entries()].map(([k, w]) => {
    const [s, t] = k.split("\u0000");
    return { s, t, w };
  });
  const tagsData = {
    ok: true, source: "local-log", generatedAt: Date.now(),
    total: entries.length, nodes, links, byTag
  };

  // 代码地图
  const fileMap = new Map();
  const unlocated = [];
  for (const e of entries) {
    const files = await filesForEntry(e).catch(() => []);
    const entry = { id: e.id, cardId: e.cardId, title: e.title, lane: e.lane, project: e.project, summary: e.summary };
    if (!files.length) { unlocated.push(entry); continue; }
    for (const p of files) {
      if (!fileMap.has(p)) fileMap.set(p, { path: p, project: e.project, entries: [] });
      const f = fileMap.get(p);
      f.entries.push(entry);
      if (!f.project) f.project = e.project;
    }
  }
  const files = [...fileMap.values()].sort((a, b) => b.entries.length - a.entries.length);
  const codeData = {
    ok: true, source: "local-log", generatedAt: Date.now(),
    total: entries.length, files, unlocated
  };

  // 语义地图：远程 embedding 优先，未接/失败回退本地字面相似度（会如实写进 embedding.mode）
  const sem = await buildSemantic(entries);
  const semNodes = entries.map((e, i) => ({
    id: e.id, cardId: e.cardId, title: e.title, summary: e.summary, lane: e.lane, project: e.project,
    x: sem.coords[i][0], y: sem.coords[i][1], v: sem.vecs[i]
  }));
  const semData = {
    ok: true, source: "local-log", generatedAt: Date.now(),
    total: entries.length, nodes: semNodes, embedding: sem.embedding
  };

  writeJsonAtomic(TAGS_FILE, tagsData);
  writeJsonAtomic(CODE_FILE, codeData);
  writeJsonAtomic(SEM_FILE, semData);
  const counts = { entries: entries.length, tags: nodes.length, links: links.length, files: files.length, unlocated: unlocated.length, embedding: sem.embedding.mode };
  writeJsonAtomic(STAMP_FILE, { version: 1, sig: logSignature(db), builtAt: Date.now(), counts, embedding: sem.embedding });
  return counts;
}

let building = null;

/**
 * 保证三份地图 JSON 是最新的：先补同步卡片，再看签名决定要不要重建。
 * 不依赖模型、不联网；几百条知识条目在 1s 内。
 */
export async function ensureKbMaps(db, { force = false } = {}) {
  activeDb = db;
  try { syncCardsToKbLog(db); } catch { /* 同步失败不挡住读取 */ }
  const sig = logSignature(db);
  const stamp = readStamp();
  const filesExist = fs.existsSync(TAGS_FILE) && fs.existsSync(CODE_FILE) && fs.existsSync(SEM_FILE);
  if (!force && stamp && stamp.sig === sig && filesExist) {
    return { built: false, ...(stamp.counts || {}) };
  }
  if (building) return building;
  building = (async () => {
    try {
      const counts = await buildMaps(db);
      return { built: true, ...counts };
    } finally {
      building = null;
    }
  })();
  return building;
}

/** 用户改完缓存后强制下次请求重建地图。 */
export function invalidateKbStamp() {
  try { fs.unlinkSync(STAMP_FILE); } catch { /* 没有就算了 */ }
}

/* ── 缓存条目管理 ─────────────────────────────────────────────── */

function logRowToItem(row) {
  return {
    id: row.id,
    cardId: row.card_id || "",
    origin: row.origin,
    title: row.title,
    summary: row.summary,
    text: row.text,
    lane: row.lane,
    project: row.project,
    tags: canonizeTags(safeParse(row.tags_json, [])),
    quotes: safeParse(row.quotes_json, []),
    source: safeParse(row.source_json, {}),
    files: safeParse(row.files_json, []),
    status: row.status,
    confidence: row.confidence,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
}

export function listKbLog(db, { q = "", status = "all", tag = "", project = "", limit = 100, offset = 0 } = {}) {
  const rows = db.prepare("SELECT * FROM kb_log ORDER BY updated_at DESC").all().map(logRowToItem);
  const needle = String(q || "").trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (status !== "all" && r.status !== status) return false;
    if (tag && !r.tags.includes(tag)) return false;
    if (project && r.project !== project) return false;
    if (needle) {
      const hay = [r.title, r.summary, r.text, r.project, r.id, ...r.tags].join(" ").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  const counts = { all: rows.length, active: 0, pending: 0, archived: 0 };
  for (const r of rows) if (counts[r.status] != null) counts[r.status] += 1;
  const max = Math.max(1, Math.min(500, Number(limit) || 100));
  const start = Math.max(0, Number(offset) || 0);
  // 列表不需要全文：正文截断，避免几百条时一次拉回几百 KB。
  const items = filtered.slice(start, start + max).map((it) => ({ ...it, text: String(it.text || "").slice(0, 400) }));
  return {
    ok: true, total: filtered.length, counts,
    vocab: loadTagVocab().canon,
    lanes: LANES,
    items
  };
}

export function updateKbLog(db, patch = {}) {
  if (!patch.id) return { ok: false, error: "缺少 id" };
  const row = db.prepare("SELECT * FROM kb_log WHERE id=?").get(patch.id);
  if (!row) return { ok: false, error: "没有这条缓存" };
  const item = logRowToItem(row);
  if (patch.title != null) {
    const title = String(patch.title).trim().slice(0, 80);
    if (!title) return { ok: false, error: "标题不能为空" };
    item.title = title;
  }
  if (patch.summary != null) item.summary = String(patch.summary).trim().slice(0, 200);
  if (patch.text != null) item.text = String(patch.text).slice(0, 4000);
  if (patch.project != null) item.project = saneProject(patch.project) || String(patch.project).trim().slice(0, 24) || "未标注";
  if (patch.lane != null && LANES.includes(patch.lane)) item.lane = patch.lane;
  if (patch.status != null && ["active", "pending", "archived"].includes(patch.status)) item.status = patch.status;
  if (patch.tags != null) {
    const tags = canonizeTags(patch.tags);
    if (!tags.length && Array.isArray(patch.tags) && patch.tags.length) {
      const derived = deriveTags({ title: item.title, summary: item.summary, text: item.text, lane: item.lane });
      item.tags = derived;
    } else item.tags = tags;
  }
  db.prepare(`UPDATE kb_log SET title=?, summary=?, text=?, project=?, lane=?, status=?, tags_json=?, updated_at=? WHERE id=?`)
    .run(item.title, item.summary, item.text, item.project, item.lane, item.status,
      JSON.stringify(item.tags), Date.now(), patch.id);
  invalidateKbStamp();
  return { ok: true, item: logRowToItem(db.prepare("SELECT * FROM kb_log WHERE id=?").get(patch.id)) };
}

export function deleteKbLog(db, id) {
  if (!id) return { ok: false, error: "缺少 id" };
  const r = db.prepare("DELETE FROM kb_log WHERE id=?").run(String(id));
  invalidateKbStamp();
  return { ok: r.changes > 0, removed: r.changes };
}

function stableHash(text) {
  let h = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function addKbLog(db, input = {}) {
  const title = String(input.title || "").trim().slice(0, 80);
  if (!title) return { ok: false, error: "标题不能为空" };
  const summary = String(input.summary || "").trim().slice(0, 200);
  const text = String(input.text || "").slice(0, 4000);
  const lane = LANES.includes(input.lane) ? input.lane : "mechanism";
  const project = saneProject(input.project) || String(input.project || "").trim().slice(0, 24) || "未标注";
  const tags = canonizeTags(input.tags);
  const finalTags = tags.length ? tags : deriveTags({ title, summary, text, lane });
  const quotes = Array.isArray(input.quotes) ? input.quotes.filter((q) => q && q.text) : [];
  const now = Date.now();
  const id = "kb_manual_" + stableHash([title, summary, project, now].join("|"));
  insertLogRow(db, {
    id, card_id: null, origin: "manual", title, summary, text, lane, project,
    tags: finalTags, quotes, source: { project, origin: "manual" },
    status: "active", confidence: "B", created_at: now, updated_at: now
  });
  invalidateKbStamp();
  return { ok: true, item: logRowToItem(db.prepare("SELECT * FROM kb_log WHERE id=?").get(id)) };
}

/** /api/kb/item 的本地兜底：知识库服务没起时，从 kb_log 拼出同样的详情结构。 */
export function kbItemFromLog(db, id) {
  if (!id) return null;
  const row = db.prepare("SELECT * FROM kb_log WHERE id=?").get(String(id));
  if (!row) return null;
  const item = logRowToItem(row);
  const src = item.source || {};
  const quote = (item.quotes[0] || {}).text || "";
  const anchor = [];
  if (src.session) anchor.push("session=" + src.session);
  if (src.time) anchor.push("time=" + src.time);
  const meta = {
    title: item.title,
    summary: item.summary,
    source: [item.project, ...anchor].filter(Boolean).join(" · "),
    project: item.project,
    session: src.session || "",
    lane: item.lane,
    tags: item.tags,
    origin: item.origin,
    updatedAt: item.updatedAt
  };
  const body = [item.title, item.summary, item.text].filter(Boolean).join("\n");
  return {
    ok: true, id: item.id, title: item.title, summary: item.summary,
    text: item.text, document: body, meta: { ...meta, cardId: item.cardId },
    quotes: item.quotes,
    tags: item.tags, confidence: item.confidence, local: true
  };
}

/* ── 本地检索（embedding 的最低档兜底） ─────────────────────────── */

let searchIndex = null;
let searchIndexSig = "";

function buildSearchIndex(db) {
  const rows = db.prepare("SELECT * FROM kb_log WHERE status='active'").all();
  const docs = rows.map((r) => {
    const item = logRowToItem(r);
    const titleToks = new Set(bigrams(item.title));
    const summaryToks = new Set(bigrams(item.summary));
    const tagToks = new Set(bigrams(item.tags.join(" ")));
    const textToks = new Set(bigrams(item.text));
    const tokens = new Set([...titleToks, ...summaryToks, ...tagToks, ...textToks]);
    return { item, tokens, titleToks, summaryToks, tagToks, textToks };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tokens) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const idf = new Map();
  for (const [t, c] of df) idf.set(t, Math.log(1 + N / (1 + c)));
  searchIndex = { docs, idf };
  searchIndexSig = logSignature(db);
  return searchIndex;
}

function weightOf(doc, token) {
  if (doc.titleToks.has(token)) return 3;
  if (doc.summaryToks.has(token)) return 2;
  if (doc.tagToks.has(token)) return 2;
  if (doc.textToks.has(token)) return 1;
  return 0;
}

function searchHitShape(it, score, quote) {
  return {
    id: it.id,
    score,
    title: it.title,
    summary: it.summary,
    quotePreview: String(quote || it.summary || it.title).slice(0, 40),
    hasMore: true,
    source: {
      project: it.project,
      session: (it.source && it.source.session) || "",
      quote: quote || "",
      anchor: ""
    },
    tags: it.tags,
    confidence: it.confidence,
    local: true
  };
}

/**
 * 关键词覆盖打分：查询的 bigram 在条目里命中多少（按词频加权）。
 * 返回和 KB /search 同形状的条目，供 whisper 的 novelty / 角标链路使用。
 */
export function localSearch(query, k = 5) {
  if (!activeDb) return [];
  const qTokens = [...new Set(bigrams(query))];
  if (!qTokens.length) return [];
  const sig = logSignature(activeDb);
  if (!searchIndex || searchIndexSig !== sig) buildSearchIndex(activeDb);
  const { docs, idf } = searchIndex;
  const totalWeight = qTokens.reduce((s, t) => s + (idf.get(t) || 0.05), 0) || 1;
  const scored = [];
  for (const d of docs) {
    let got = 0;
    for (const t of qTokens) {
      const w = weightOf(d, t);
      if (w) got += (idf.get(t) || 0.05) * Math.min(1, w / 3 + 0.34);
    }
    if (!got) continue;
    const score = Math.max(0, Math.min(1, got / totalWeight));
    if (score <= 0) continue;
    scored.push({ doc: d, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Number(k) || 5)).map(({ doc, score }) => {
    const it = doc.item;
    const quote = (it.quotes[0] || {}).text || it.summary || it.title;
    return searchHitShape(it, score, quote);
  });
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 检索优先走远程 embedding（可选开关 useForSearch；只对已经在缓存里的条目向量做比较，
 * 不会为每条知识额外发请求）。任何失败都退回 localSearch，不阻塞实时链路。
 */
export async function localSearchAsync(query, k = 5) {
  const base = localSearch(query, k);
  const cfg = loadEmbeddingConfig();
  if (!cfg.useForSearch || !embeddingConfigured(cfg)) return base;
  if (!activeDb) return base;
  try {
    const sig = logSignature(activeDb);
    if (!searchIndex || searchIndexSig !== sig) buildSearchIndex(activeDb);
    const docs = searchIndex.docs;
    const r = await embedTexts([query], cfg);
    const qv = r.vectors[0];
    if (!qv || !qv.length) return base;
    const scored = [];
    for (const d of docs) {
      const v = cachedEmbedding(entryText(d.item), cfg);
      if (!v || v.length !== qv.length) continue;
      const cos = cosine(qv, v);
      if (cos <= 0) continue;
      const kw = (base.find((b) => b.id === d.item.id) || {}).score || 0;
      scored.push({ doc: d, score: Math.max(0, Math.min(1, cos * 0.8 + kw * 0.2)) });
    }
    if (!scored.length) return base;
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, Number(k) || 5)).map(({ doc, score }) => {
      const it = doc.item;
      const quote = (it.quotes[0] || {}).text || it.summary || it.title;
      return searchHitShape(it, score, quote);
    });
  } catch {
    return base;
  }
}

export function localSearchReady() {
  return !!activeDb;
}

/* ── CLI ──────────────────────────────────────────────────────── */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const dbArg = args.indexOf("--db");
  const db = openDb(dbArg > -1 ? path.resolve(args[dbArg + 1]) : dbPath(ROOT));
  activeDb = db;
  const run = async () => {
    const synced = syncCardsToKbLog(db);
    if (args.includes("--sync")) {
      console.log(`kb_log: +${synced.added} (total ${synced.total})`);
      return;
    }
    const counts = await ensureKbMaps(db, { force: true });
    console.log(`kb_log: +${synced.added} (total ${synced.total})`);
    console.log(`maps: entries=${counts.entries} tags=${counts.tags} links=${counts.links} files=${counts.files} unlocated=${counts.unlocated} embedding=${counts.embedding || "local-tfidf"}`);
    console.log(`-> data/kb-tags.json · kb-code-map.json · kb-map.json`);
  };
  run().catch((e) => { console.error(e); process.exit(1); });
}
