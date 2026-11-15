/**
 * weekly — 每周温故：周一后第一次打开，弹一次「上周涉及到的卡片 + 只含这些卡片的标签网络」。
 * 数据全部现算，不建表；只把「看过了」写在 data/weekly.json。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const SEEN_FILE = path.join(DATA, "weekly.json");
const TAGS_FILE = path.join(DATA, "kb-tags.json");
const ENABLED_FROM = new Date(2026, 10, 16, 0, 0, 0); // 2026-11-16 周一起启用
const DAY = 24 * 3600 * 1000;
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")).seen || {}; } catch { return {}; }
}
function saveSeen(seen) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify({ seen }, null, 2));
  } catch {}
}

function mondayOf(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function isoWeekKey(d) {
  const t = new Date(d.getTime());
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const week1 = new Date(t.getFullYear(), 0, 4);
  const n = 1 + Math.round(((t - week1) / DAY - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return t.getFullYear() + "-W" + String(n).padStart(2, "0");
}

function tagsForCard(card, canon, map, conceptName) {
  const out = new Set();
  let terms = [];
  try { terms = JSON.parse(card.terms_json || "[]"); } catch {}
  const raw = [];
  for (const t of terms) raw.push(typeof t === "string" ? t : t && t.term);
  raw.push(conceptName || "");
  for (const t of raw) {
    const s = String(t || "").trim();
    if (!s) continue;
    if (canon.has(s)) out.add(s);
    else if (map[s]) out.add(map[s]);
  }
  return [...out];
}

export function weekly(db, { force = false, now = new Date() } = {}) {
  const curMon = mondayOf(now);
  const prevMon = new Date(curMon.getTime() - 7 * DAY);
  const weekKey = isoWeekKey(prevMon);
  const seen = loadSeen();
  const enabled = now.getTime() >= ENABLED_FROM.getTime();

  let tagMap = { canon: [], map: {} };
  try { tagMap = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "tools", "tag-map.json"), "utf8")); } catch {}
  const canon = new Set(tagMap.canon || []);
  const map = tagMap.map || {};

  const rows = db.prepare("SELECT card_id, action, correct, ts FROM review WHERE ts >= ? AND ts < ? ORDER BY ts")
    .all(prevMon.getTime(), curMon.getTime());

  const byCard = new Map();
  for (const r of rows) {
    if (!byCard.has(r.card_id)) byCard.set(r.card_id, { id: r.card_id, quiz: 0, correct: 0, wrong: 0, got: 0, nope: 0, taught: 0, last: 0 });
    const c = byCard.get(r.card_id);
    c.last = Math.max(c.last, r.ts || 0);
    if (r.action === "quiz") { c.quiz += 1; if (Number(r.correct) === 1) c.correct += 1; else c.wrong += 1; }
    else if (r.action === "got") c.got += 1;
    else if (r.action === "nope") c.nope += 1;
    else if (r.action === "taught") c.taught += 1;
  }

  const cardRows = {};
  if (byCard.size) {
    const ids = [...byCard.keys()];
    const q = db.prepare(`SELECT * FROM card WHERE id IN (${ids.map(() => "?").join(",")})`);
    const concepts = {};
    for (const c of db.prepare("SELECT id,name FROM concept").all()) concepts[c.id] = c.name;
    for (const r of q.all(...ids)) {
      cardRows[r.id] = {
        id: r.id, title: r.title, lane: r.lane, project: (JSON.parse(r.source_json || "{}").project) || "",
        concept: concepts[r.concept_id] || "",
        tags: tagsForCard(r, canon, map, concepts[r.concept_id])
      };
    }
  }

  const cards = [...byCard.values()]
    .filter((c) => cardRows[c.id])
    .map((c) => ({ ...cardRows[c.id], ...c }))
    .sort((a, b) => b.last - a.last);

  const tagCount = new Map();
  const linkCount = new Map();
  for (const c of cards) {
    for (const t of c.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    for (let i = 0; i < c.tags.length; i++) {
      for (let j = i + 1; j < c.tags.length; j++) {
        const a = c.tags[i], b = c.tags[j];
        const k = a < b ? a + "|" + b : b + "|" + a;
        linkCount.set(k, (linkCount.get(k) || 0) + 1);
      }
    }
  }
  // 和知识地图的标签网络同一套颜色：按标签在知识库里的主项目取色
  let kbTagColor = {};
  try {
    const kbTags = JSON.parse(fs.readFileSync(TAGS_FILE, "utf8"));
    for (const n of kbTags.nodes || []) kbTagColor[n.id] = n.c;
  } catch {}
  const PALETTE = ["#3d6b52", "#8a5a2b", "#3f5a78", "#b4432e", "#6b5b8a", "#2f6f6a", "#8a4b4b", "#5b6b3d", "#8b867d"];
  const tags = {
    nodes: [...tagCount.entries()].map(([id, n], i) => ({ id, n, c: kbTagColor[id] || PALETTE[i % PALETTE.length] })),
    links: [...linkCount.entries()].map(([k, w]) => { const [s, t] = k.split("|"); return { s, t, w }; })
  };

  const stats = {
    cards: cards.length,
    quizzes: cards.reduce((n, c) => n + c.quiz, 0),
    correct: cards.reduce((n, c) => n + c.correct, 0),
    wrong: cards.reduce((n, c) => n + c.wrong, 0),
    newCards: cards.reduce((n, c) => n + (c.taught ? 1 : 0), 0)
  };

  return {
    ok: true,
    enabled,
    show: (force || enabled) && !seen[weekKey],
    seen: !!seen[weekKey],
    week: {
      key: weekKey,
      start: fmt(prevMon),
      end: fmt(new Date(curMon.getTime() - DAY))
    },
    stats,
    cards,
    tags,
    empty: cards.length === 0
  };
}

export function markSeen(weekKey) {
  if (!weekKey) return false;
  const seen = loadSeen();
  seen[weekKey] = true;
  saveSeen(seen);
  return true;
}
