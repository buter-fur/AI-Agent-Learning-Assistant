import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureDir } from "./util.mjs";

export const SCHEMA_VERSION = 1;

const DDL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS concept (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  problem TEXT NOT NULL DEFAULT '',
  lane TEXT NOT NULL DEFAULT 'mechanism',
  desc TEXT NOT NULL DEFAULT '',
  level INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS card (
  id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  concept_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'L1',
  title TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]',
  answer_index INTEGER NOT NULL DEFAULT 0,
  answer TEXT NOT NULL DEFAULT '',
  metaphor TEXT NOT NULL DEFAULT '',
  explain TEXT NOT NULL DEFAULT '',
  terms_json TEXT NOT NULL DEFAULT '[]',
  takeaway TEXT NOT NULL DEFAULT '',
  boundary_json TEXT,
  figure_json TEXT,
  quiz_json TEXT NOT NULL DEFAULT '[]',
  source_json TEXT NOT NULL DEFAULT '{}',
  cross_json TEXT NOT NULL DEFAULT '[]',
  shape TEXT NOT NULL DEFAULT 'concept',
  workflow_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL DEFAULT 0,
  seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_card_lane ON card(lane, created_at);
CREATE INDEX IF NOT EXISTS idx_card_concept ON card(concept_id);

CREATE TABLE IF NOT EXISTS edge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  UNIQUE(from_id, to_id, kind)
);

CREATE TABLE IF NOT EXISTS concept_state (
  concept_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'unknown',   -- unknown | taught | practicing | known
  s REAL NOT NULL DEFAULT 0,               -- 掌握度 0..1
  corrects INTEGER NOT NULL DEFAULT 0,     -- 答对次数（不同题型）
  types_json TEXT NOT NULL DEFAULT '[]',   -- 已答对的题型
  last_seen INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  action TEXT NOT NULL,
  quiz_index INTEGER,
  picked INTEGER,
  correct INTEGER,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_card ON review(card_id, ts DESC);

-- 历史旁听：从旧会话补生成的卡，以及已经处理过的实时旁听条目都落在这里。
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- generated | processed
  card_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  lane TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  card_json TEXT NOT NULL DEFAULT '{}',
  session_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);

-- 已经提取过的会话轮次，避免每次启动都从同一轮重复制卡。
CREATE TABLE IF NOT EXISTS history_scan (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, turn)
);

CREATE TABLE IF NOT EXISTS history_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 每个会话的实时旁听/历史补课开关；没有行 = 默认开启，保持旧行为。
CREATE TABLE IF NOT EXISTS session_scan (
  session_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- 主动路径发现的「种子卡」：先只存标题/结论/引文，用户点开再扩成完整卡。
CREATE TABLE IF NOT EXISTS seed (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  title TEXT NOT NULL,
  takeaway TEXT NOT NULL,
  quote TEXT NOT NULL,
  text TEXT NOT NULL,
  lane TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seed_hash ON seed(hash);

-- 知识缓存（知识库的本地轻量替身）：不受 50 张卡上限约束，卡片只是它的一类来源。
-- 知识地图（标签网络/代码地图/语义地图）都从这里出，用户可以在卡片站里管理。
CREATE TABLE IF NOT EXISTS kb_log (
  id TEXT PRIMARY KEY,
  card_id TEXT,                            -- 关联卡片（如果有）
  origin TEXT NOT NULL DEFAULT 'card',     -- card | history | seed | manual | ingest
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  lane TEXT NOT NULL DEFAULT 'mechanism',
  project TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  quotes_json TEXT NOT NULL DEFAULT '[]',
  source_json TEXT NOT NULL DEFAULT '{}',
  files_json TEXT NOT NULL DEFAULT '[]',   -- 代码地图：来源文件（自动探测后落库）
  status TEXT NOT NULL DEFAULT 'active',   -- active | pending | archived
  confidence TEXT NOT NULL DEFAULT 'A',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_kb_log_status ON kb_log(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_log_project ON kb_log(project);
CREATE INDEX IF NOT EXISTS idx_kb_log_card ON kb_log(card_id);
`;

export function openDb(dbFile) {
  ensureDir(path.dirname(dbFile));
  const db = new DatabaseSync(dbFile);
  db.exec(DDL);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  migrate(db);
  return db;
}

export function upsertConcepts(db, concepts) {
  const st = db.prepare(`INSERT INTO concept(id,name,domain,problem,lane,desc,level)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, domain=excluded.domain,
      problem=excluded.problem, lane=excluded.lane, desc=excluded.desc, level=excluded.level`);
  for (const c of concepts) {
    st.run(c.id, c.name || c.id, c.domain || "", c.problem || "", c.lane || "mechanism", c.desc || "", Number(c.level) || 0);
  }
}

export function upsertCards(db, cards) {
  const st = db.prepare(`INSERT INTO card(
      id,lane,concept_id,level,title,scene,question,options_json,answer_index,answer,
      metaphor,explain,terms_json,takeaway,boundary_json,figure_json,quiz_json,source_json,cross_json,shape,workflow_json,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      lane=excluded.lane, concept_id=excluded.concept_id, level=excluded.level,
      title=excluded.title, scene=excluded.scene, question=excluded.question,
      options_json=excluded.options_json, answer_index=excluded.answer_index, answer=excluded.answer,
      metaphor=excluded.metaphor, explain=excluded.explain, terms_json=excluded.terms_json,
      takeaway=excluded.takeaway, boundary_json=excluded.boundary_json, figure_json=excluded.figure_json,
      quiz_json=excluded.quiz_json, source_json=excluded.source_json, cross_json=excluded.cross_json,
      shape=excluded.shape, workflow_json=excluded.workflow_json,
      status=excluded.status, created_at=excluded.created_at`);
  for (const c of cards) {
    st.run(
      c.id, c.lane, c.conceptId, c.level || "L1", c.title, c.scene || "", c.question || "",
      JSON.stringify(c.options || []), Number(c.answerIndex) || 0, c.answer || "",
      c.metaphor || "", c.explain || "", JSON.stringify(c.terms || []), c.takeaway || "",
      c.boundary ? JSON.stringify(c.boundary) : null,
      c.figure ? JSON.stringify(c.figure) : null,
      JSON.stringify(c.quiz || []),
      JSON.stringify(c.source || {}),
      JSON.stringify(c.crossProject || []),
      c.shape || "concept",
      c.workflow ? JSON.stringify(c.workflow) : null,
      c.status || "active",
      c.createdAt || Date.now()
    );
  }
}

export function upsertEdges(db, edges) {
  const st = db.prepare(`INSERT INTO edge(from_id,to_id,kind,reason) VALUES(?,?,?,?)
    ON CONFLICT(from_id,to_id,kind) DO UPDATE SET reason=excluded.reason`);
  for (const e of edges) st.run(e.from, e.to, e.kind, e.reason || "");
}

export function migrate(db) {
  ensureColumn(db, "card", "examples_json", "examples_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "card", "shape", "shape TEXT NOT NULL DEFAULT 'concept'");
  ensureColumn(db, "card", "workflow_json", "workflow_json TEXT");
  ensureColumn(db, "concept_state", "rung", "rung INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "concept_state", "rung_types_json", "rung_types_json TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "concept_state", "rung_at", "rung_at INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "concept_state", "wrong_streak", "wrong_streak INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "card", "seen_at", "seen_at INTEGER NOT NULL DEFAULT 0");
  // 只在第一次迁移时把旧卡标为已看；之后新生成的卡保持未看，重启不会把 +n 清零。
  if (!db.prepare("SELECT value FROM meta WHERE key='seen_baseline_done'").get()) {
    db.prepare(`UPDATE card SET seen_at=? WHERE seen_at=0 AND COALESCE(source_json,'') NOT LIKE '%"origin":"history"%'`).run(Date.now());
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('seen_baseline_done','1')").run();
  }
}

export function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function getState(db, conceptId) {
  const row = db.prepare("SELECT * FROM concept_state WHERE concept_id=?").get(conceptId);
  if (!row) return { concept_id: conceptId, state: "unknown", s: 0, corrects: 0, types: [], rung: 0, rung_types: [], rung_at: 0, last_seen: 0, wrong_streak: 0 };
  return { ...row, types: JSON.parse(row.types_json || "[]"), rung_types: JSON.parse(row.rung_types_json || "[]"), wrong_streak: row.wrong_streak || 0 };
}

export function applyEvent(db, conceptId, kind, detail = {}) {
  const st = getState(db, conceptId);
  const now = Date.now();
  let { state, s, corrects } = st;
  const types = new Set(st.types || []);
  let rung = st.rung || 0;
  let rungTypes = new Set(st.rung_types || []);
  let rungAt = st.rung_at || 0;
  let wrongStreak = st.wrong_streak || 0;
  let demoted = false;
  if (kind === "taught") { s = Math.min(1, s + 0.2); if (state === "unknown") state = "taught"; }
  else if (kind === "correct") {
    wrongStreak = 0;
    const t = detail.type || "recall";
    const w = t === "apply" ? 0.3 : t === "contrast" ? 0.25 : t === "trace" ? 0.25 : 0.15;
    s = Math.min(1, s + w); corrects += 1; types.add(t);
    state = s >= 0.65 - 1e-9 && corrects >= 2 && types.size >= 2 ? "known" : "practicing";
    rungTypes.add(detail.type || "recall");
    const WEEK = 7 * 24 * 3600 * 1000;
    if (rungTypes.size >= 2 && rung < 4 && now - rungAt > WEEK) {
      rung += 1; rungAt = now; rungTypes = new Set();
    }
  } else if (kind === "wrong") {
    s = Math.max(0, s - 0.15);
    state = state === "known" ? "practicing" : "practicing";
    wrongStreak += 1;
    if (wrongStreak >= 2 && rung > 0) {   // 现有标准：连续两次答错 → 回退一档
      rung -= 1; rungAt = now; wrongStreak = 0; demoted = true;
    }
  }
  else if (kind === "self-claim") { s = Math.min(1, s + 0.4); state = s >= 0.65 ? "known" : "taught"; }
  else if (kind === "used") { s = Math.min(1, s + 0.2); }

  db.prepare(`INSERT INTO concept_state(concept_id,state,s,corrects,types_json,last_seen,updated_at,rung,rung_types_json,rung_at,wrong_streak)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(concept_id) DO UPDATE SET state=excluded.state,s=excluded.s,corrects=excluded.corrects,
      types_json=excluded.types_json,last_seen=excluded.last_seen,updated_at=excluded.updated_at,
      rung=excluded.rung,rung_types_json=excluded.rung_types_json,rung_at=excluded.rung_at,
      wrong_streak=excluded.wrong_streak`)
    .run(conceptId, state, s, corrects, JSON.stringify([...types]), now, now, rung, JSON.stringify([...rungTypes]), rungAt, wrongStreak);
  return { state, s, corrects, rung, demoted, wrongStreak };
}

export function recordReview(db, { cardId, action, quizIndex = null, picked = null, correct = null }) {
  db.prepare("INSERT INTO review(card_id,action,quiz_index,picked,correct,ts) VALUES(?,?,?,?,?,?)")
    .run(cardId, action, quizIndex, picked, correct, Date.now());
}

export function rowToCard(r) {
  return {
    id: r.id, lane: r.lane, conceptId: r.concept_id, level: r.level,
    title: r.title, scene: r.scene, question: r.question,
    options: JSON.parse(r.options_json || "[]"), answerIndex: r.answer_index,
    answer: r.answer, metaphor: r.metaphor, explain: r.explain,
    terms: JSON.parse(r.terms_json || "[]"), takeaway: r.takeaway,
    boundary: r.boundary_json ? JSON.parse(r.boundary_json) : null,
    figure: r.figure_json ? JSON.parse(r.figure_json) : null,
    quiz: JSON.parse(r.quiz_json || "[]"),
    source: JSON.parse(r.source_json || "{}"),
    crossProject: JSON.parse(r.cross_json || "[]"),
    shape: r.shape || "concept",
    workflow: r.workflow_json ? JSON.parse(r.workflow_json) : null,
    examples: r.examples_json ? JSON.parse(r.examples_json) : [],
    createdAt: r.created_at,
    seenAt: r.seen_at || 0
  };
}

/** 手动调档：太浅了 +1（0–4），绝不越过 G4；降档只由「连续答错」自动发生，不在这里。 */
export function adjustRung(db, conceptId, delta) {
  const st = getState(db, conceptId);
  const now = Date.now();
  const rung = Math.max(0, Math.min(4, (st.rung || 0) + Number(delta || 0)));
  db.prepare(`INSERT INTO concept_state(concept_id,state,s,corrects,types_json,last_seen,updated_at,rung,rung_types_json,rung_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(concept_id) DO UPDATE SET rung=excluded.rung, rung_at=excluded.rung_at, updated_at=excluded.updated_at, last_seen=excluded.last_seen`)
    .run(conceptId, st.state || "unknown", st.s || 0, st.corrects || 0, JSON.stringify(st.types || []),
         now, now, rung, JSON.stringify(st.rung_types || []), now);
  return { rung, state: st.state || "unknown" };
}

export function getBundle(db) {
  // 学习状态统一从 concept_state 出：卡片流、概念图、旁听面板都读同一份，别再各自按 level 猜档位。
  const states = {};
  for (const r of db.prepare("SELECT * FROM concept_state").all()) {
    states[r.concept_id] = {
      state: r.state, s: r.s, rung: r.rung || 0,
      types: JSON.parse(r.types_json || "[]"),
      rungTypes: JSON.parse(r.rung_types_json || "[]"),
      rungAt: r.rung_at || 0, lastSeen: r.last_seen || 0, corrects: r.corrects || 0
    };
  }
  const cards = db.prepare("SELECT * FROM card WHERE status != 'rejected' ORDER BY created_at DESC").all().map((r) => ({
    id: r.id,
    lane: r.lane,
    conceptId: r.concept_id,
    level: r.level,
    title: r.title,
    scene: r.scene,
    question: r.question,
    options: JSON.parse(r.options_json || "[]"),
    answerIndex: r.answer_index,
    answer: r.answer,
    metaphor: r.metaphor,
    explain: r.explain,
    terms: JSON.parse(r.terms_json || "[]"),
    takeaway: r.takeaway,
    boundary: r.boundary_json ? JSON.parse(r.boundary_json) : null,
    figure: r.figure_json ? JSON.parse(r.figure_json) : null,
    quiz: JSON.parse(r.quiz_json || "[]"),
    source: JSON.parse(r.source_json || "{}"),
    crossProject: JSON.parse(r.cross_json || "[]"),
    shape: r.shape || "concept",
    workflow: r.workflow_json ? JSON.parse(r.workflow_json) : null,
    createdAt: r.created_at,
    seenAt: r.seen_at || 0
  }));
  const concepts = db.prepare("SELECT * FROM concept ORDER BY lane, domain, problem").all();
  const edges = db.prepare("SELECT from_id, to_id, kind, reason FROM edge").all().map((e) => ({
    from: e.from_id, to: e.to_id, kind: e.kind, reason: e.reason
  }));
  const byLane = {};
  for (const c of cards) byLane[c.lane] = (byLane[c.lane] || 0) + 1;
  return {
    version: SCHEMA_VERSION,
    generatedAt: Date.now(),
    cards,
    concepts,
    edges,
    states,
    stats: {
      cards: cards.length,
      concepts: concepts.length,
      byLane,
      unseen: db.prepare("SELECT COUNT(*) c FROM card WHERE status='active' AND seen_at=0").get().c
    }
  };
}

export function dbPath(root) {
  return path.join(root, "data", "cards.db");
}

export function resetDb(file) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(file + suffix); } catch { /* ignore */ }
  }
}
