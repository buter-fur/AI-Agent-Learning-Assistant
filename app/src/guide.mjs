/**
 * guide — 知识点引导：顺着概念图推 1 个下一步 / 一条 3 步路径 / 缺口。
 * 只算建议，不预生成内容；用户点了才出。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const EXPOSURE = path.join(DATA, "exposure.jsonl");
const GUIDE_LOG = path.join(DATA, "guide-log.json");
const WEEK = 7 * 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

const KIND_W = { prereq: 0.35, cause: 0.25, contrast: 0.2, same: 0.15 };
const KIND_LABEL = { prereq: "前置", cause: "因果", contrast: "对比", same: "同源" };

export function logExposure(conceptId) {
  if (!conceptId) return;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(EXPOSURE, JSON.stringify({ conceptId, ts: Date.now() }) + "\n");
  } catch {}
}

function exposures() {
  try {
    return fs.readFileSync(EXPOSURE, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch { return []; }
}

function guideLog() {
  try { return JSON.parse(fs.readFileSync(GUIDE_LOG, "utf8")); } catch { return { items: [] }; }
}

function saveGuideLog(log) {
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(GUIDE_LOG, JSON.stringify(log)); } catch {}
}

const withinDay = (ts) => Date.now() - ts < DAY;
const withinWeek = (ts) => Date.now() - ts < WEEK;

export function limits() {
  const log = guideLog();
  return {
    sameConceptToday: log.items.filter((x) => withinDay(x.ts)).map((x) => x.conceptId),
    kindToday: log.items.filter((x) => withinDay(x.ts)).length
  };
}

export function recordGuide(conceptId, kind) {
  const log = guideLog();
  log.items.push({ conceptId, kind, ts: Date.now() });
  log.items = log.items.slice(-200);
  saveGuideLog(log);
}

function stateOf(db, conceptId) {
  return db.prepare("SELECT * FROM concept_state WHERE concept_id=?").get(conceptId) || null;
}

function learned(db, conceptId) {
  const st = stateOf(db, conceptId);
  return !!st && (st.state === "known" || (st.rung || 0) >= 3);
}

function cardFor(db, conceptId, rung) {
  const rows = db.prepare("SELECT * FROM card WHERE concept_id=? AND status='active'").all(conceptId);
  if (!rows.length) return null;
  const rank = (r) => (r.shape === "workflow" ? 4 : Number(String(r.level || "L2").slice(1)) || 2);
  rows.sort((a, b) => Math.abs(rank(a) - rung) - Math.abs(rank(b) - rung));
  return rows[0];
}

/** 没有指定概念时，从「已经在学、还没到 G4」的前沿里挑一个（曝光多的优先）。 */
export function frontier(db) {
  const concepts = db.prepare("SELECT * FROM concept").all();
  const states = {};
  for (const s of db.prepare("SELECT * FROM concept_state").all()) states[s.concept_id] = s;
  const counts = {};
  for (const e of exposures()) counts[e.conceptId] = (counts[e.conceptId] || 0) + 1;
  const pool = concepts.filter((c) => {
    const st = states[c.id];
    return !st || (st.state !== "known" && (st.rung || 0) < 4);
  });
  pool.sort((a, b) => {
    const ra = ((states[a.id] || {}).rung || 0) > 0 ? 1 : 0;
    const rb = ((states[b.id] || {}).rung || 0) > 0 ? 1 : 0;
    if (ra !== rb) return rb - ra;
    const ea = counts[a.id] || 0, eb = counts[b.id] || 0;
    if (ea !== eb) return eb - ea;
    return String(a.name).localeCompare(String(b.name), "zh");
  });
  return pool.length ? pool[0].id : null;
}

export function next(db, conceptId) {
  if (!conceptId) conceptId = frontier(db);
  if (!conceptId) return null;
  const fromState = stateOf(db, conceptId);
  const rung = fromState ? fromState.rung || 0 : 0;
  const edges = db.prepare("SELECT * FROM edge WHERE from_id=? OR to_id=?").all(conceptId, conceptId);
  const concepts = Object.fromEntries(db.prepare("SELECT * FROM concept").all().map((c) => [c.id, c]));
  const counts = {};
  for (const e of exposures()) counts[e.conceptId] = (counts[e.conceptId] || 0) + 1;
  const lim = limits();

  const cands = [];
  for (const e of edges) {
    const other = e.from_id === conceptId ? e.to_id : e.from_id;
    if (!concepts[other] || learned(db, other)) continue;
    const isForward = e.from_id === conceptId;
    let score = (KIND_W[e.kind] || 0.1) + Math.min(0.3, (counts[other] || 0) * 0.05);
    if (e.kind === "prereq" && isForward) score += 0.1;   // 反向：它是我的前置
    if (lim.sameConceptToday.includes(other)) score -= 5;  // 今天推过
    cands.push({ concept: concepts[other], kind: e.kind, reason: e.reason, score, edge: e });
  }

  // 两跳：一跳没有可用时，找 A→B→C
  if (!cands.length) {
    for (const e of edges) {
      const mid = e.from_id === conceptId ? e.to_id : e.from_id;
      if (!concepts[mid] || learned(db, mid)) continue;
      const e2 = db.prepare("SELECT * FROM edge WHERE from_id=? OR to_id=?").all(mid, mid)
        .find((x) => (x.from_id === mid ? x.to_id : x.from_id) !== conceptId);
      const end = e2 && ((e2.from_id === mid) ? e2.to_id : e2.from_id);
      if (end && concepts[end] && !learned(db, end)) {
        cands.push({ concept: concepts[end], kind: e.kind, reason: e.reason, score: 0.2,
                     via: concepts[mid], edge: e2 });
      }
    }
  }

  // 兜底：图上没有邻居时，同领域里找一个还没学的
  if (!cands.length) {
    const self = concepts[conceptId];
    if (self) {
      for (const c of Object.values(concepts)) {
        if (c.id === conceptId || c.domain !== self.domain || learned(db, c.id)) continue;
        cands.push({ concept: c, kind: "same", reason: "同一领域，顺手补一下", score: 0.1 });
      }
    }
  }

  cands.sort((a, b) => b.score - a.score);
  const pick = cands[0];
  if (!pick) return null;
  const card = cardFor(db, pick.concept.id, rung);
  return {
    concept: { id: pick.concept.id, name: pick.concept.name, desc: pick.concept.desc },
    kind: pick.kind, kindLabel: KIND_LABEL[pick.kind] || pick.kind,
    reason: pick.reason || "", via: pick.via ? pick.via.name : null,
    card: card ? { id: card.id, title: card.title, level: card.level, shape: card.shape } : null,
    score: Number(pick.score.toFixed(2)), rung
  };
}

export function path3(db, conceptId) {
  if (!conceptId) conceptId = frontier(db);
  if (!conceptId) return [];
  const steps = [];
  const concepts = Object.fromEntries(db.prepare("SELECT * FROM concept").all().map((c) => [c.id, c]));
  const pre = db.prepare("SELECT * FROM edge WHERE to_id=? AND kind='prereq'").all(conceptId)
    .map((e) => concepts[e.from_id]).filter((c) => c && !learned(db, c.id))[0];
  if (pre) steps.push({ role: "先补前置", concept: pre });
  if (concepts[conceptId]) steps.push({ role: "当前", concept: concepts[conceptId] });
  const nx = next(db, conceptId);
  if (nx) steps.push({ role: "之后", concept: { id: nx.concept.id, name: nx.concept.name } });
  return steps;
}

export function gaps(db, limit = 3) {
  const counts = {};
  for (const e of exposures()) counts[e.conceptId] = (counts[e.conceptId] || 0) + 1;
  const concepts = Object.fromEntries(db.prepare("SELECT * FROM concept").all().map((c) => [c.id, c]));
  const lim = limits();
  const out = [];
  for (const [cid, n] of Object.entries(counts)) {
    if (n < 3 || !concepts[cid] || learned(db, cid)) continue;
    out.push({ concept: { id: cid, name: concepts[cid].name, desc: concepts[cid].desc }, count: n });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, Math.min(limit, 3));
}
