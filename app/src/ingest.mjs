#!/usr/bin/env node
/**
 * ingest — 把卡片工厂（或 API）产出的 JSON 校验后写进 SQLite。
 * 核心防幻觉闸门：source.quotes 必须能在原始会话日志里逐字找到。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonlSync, listSessionFiles, ensureDir, truncate } from "./util.mjs";
import { openDb, upsertCards, upsertConcepts, upsertEdges, dbPath, resetDb } from "./db.mjs";
import { logCardEntry, syncCardsToKbLog } from "./kbmap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIMITS = { title: 18, scene: 80, question: 40, answer: 40, metaphor: 80, explain: 140, takeaway: 50, query: 40 };

function parseArgs(argv) {
  const o = { inDir: path.join(ROOT, "data", "out"), db: dbPath(ROOT), verify: true, reset: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") o.inDir = path.resolve(argv[++i]);
    else if (a === "--db") o.db = path.resolve(argv[++i]);
    else if (a === "--no-verify") o.verify = false;
    else if (a === "--reset") o.reset = true;
  }
  return o;
}

const len = (s) => [...String(s || "")].length;
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();

/** 默认 data/out 下按 generate 的批次目录找最新 batch.json。 */
function latestBatchDir(root) {
  let best = null;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 4) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (!best || st.mtimeMs > best.mtime) best = { dir, mtime: st.mtimeMs };
    }
  }
  return best ? best.dir : null;
}

function collectText(rows) {
  const out = [];
  const pushBlock = (content) => {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b && typeof b.text === "string") out.push(b.text);
      if (b && typeof b.arguments === "string") out.push(b.arguments);
    }
  };
  for (const r of rows) {
    if (r.type === "user/message" || r.type === "assistant/message" || r.type === "tool/result") {
      if (r.data && r.data.message) pushBlock(r.data.message.content);
      if (r.data) pushBlock(r.data.content);
    }
    if (r.type === "tool/call" && r.data && typeof r.data.arguments === "string") out.push(r.data.arguments);
    if (r.type === "compaction/summary" && r.data) out.push(JSON.stringify(r.data));
  }
  return out.join("\n");
}

async function buildSessionIndex() {
  const files = listSessionFiles();
  return files.map((f) => ({ ...f, id: path.basename(f.sessionDir) }));
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const index = await buildSessionIndex();
  const cache = new Map();

  async function corpusFor(sessionRef) {
    if (!sessionRef) return "";
    const key = String(sessionRef);
    if (cache.has(key)) return cache.get(key);
    const hit = index.find((f) => f.id.startsWith(key) || f.id.includes(key.replace(/^session-/, "")));
    let text = "";
    if (hit) {
      try {
        const rows = await readJsonlSync(hit.file);
        text = collectText(rows);
      } catch { text = ""; }
    }
    cache.set(key, text);
    return text;
  }

  if (!fs.existsSync(opt.inDir)) {
    console.error(`no such dir: ${opt.inDir}`);
    process.exit(1);
  }
  let files = fs.readdirSync(opt.inDir).filter((f) => f.endsWith(".json"));
  if (!files.length) {
    const latest = latestBatchDir(opt.inDir);
    if (latest && latest !== opt.inDir) {
      opt.inDir = latest;
      files = fs.readdirSync(opt.inDir).filter((f) => f.endsWith(".json"));
    }
  }
  if (!files.length) {
    console.error(`no *.json in ${opt.inDir}`);
    process.exit(1);
  }

  if (opt.reset) resetDb(opt.db);
  const db = openDb(opt.db);

  const allCards = [];
  const allConcepts = [];
  const allEdges = [];
  const rejects = [];

  for (const f of files) {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(path.join(opt.inDir, f), "utf8"));
    } catch (e) {
      rejects.push({ file: f, id: "-", reasons: [`JSON 解析失败: ${e.message}`] });
      continue;
    }
    const cards = Array.isArray(payload) ? payload : payload.cards || [];
    if (Array.isArray(payload.concepts)) allConcepts.push(...payload.concepts);
    if (Array.isArray(payload.edges)) allEdges.push(...payload.edges);

    for (const c of cards) {
      const reasons = [];
      const problems = [];
      for (const [k, max] of Object.entries(LIMITS)) {
        if (c[k] && len(c[k]) > max) problems.push(`${k} ${len(c[k])}>${max}`);
      }
      const isWorkflow = c.shape === "workflow";
      if (!isWorkflow) {
        const total = ["title", "scene", "question", "metaphor", "explain", "takeaway"].reduce((n, k) => n + len(c[k]), 0);
        if (total > 320) problems.push(`总字数 ${total}>320`);
      }
      if (!c.id || !c.lane || !c.conceptId) reasons.push("缺少 id/lane/conceptId");
      if (!["mechanism", "syntax", "algorithm", "judgment"].includes(c.lane)) reasons.push(`lane 非法: ${c.lane}`);
      if (isWorkflow) {
        const wf = c.workflow || {};
        if (!Array.isArray(wf.steps) || wf.steps.length < 3) reasons.push("工作流卡缺少 steps（≥3）");
        if (!Array.isArray(wf.decisions) || wf.decisions.length < 3) reasons.push("工作流卡缺少 decisions（≥3）");
        if (!Array.isArray(wf.scenarios) || wf.scenarios.length < 3) reasons.push("工作流卡缺少 scenarios（≥3）");
        if (!c.source || !c.source.project) reasons.push("工作流卡缺少 source.project");
      } else {
        if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > 3) reasons.push("options 必须 2–3 个");
        else if (!c.options.includes("我不知道")) reasons.push("options 缺少「我不知道」");
        if (!Number.isInteger(c.answerIndex) || c.answerIndex < 0 || c.answerIndex >= (c.options || []).length) reasons.push("answerIndex 越界");
        else if ((c.options || [])[c.answerIndex] === "我不知道") reasons.push("answerIndex 不能指向「我不知道」");
        if (!Array.isArray(c.terms) || c.terms.length > 3) reasons.push("terms 必须 ≤3");
        if (!Array.isArray(c.quiz) || c.quiz.length < 1) reasons.push("quiz 至少 1 道");
      }

      const quotes = (c.source && c.source.quotes) || [];
      if (!quotes.length && !isWorkflow) reasons.push("source.quotes 至少 1 条");
      if (reasons.length === 0 && opt.verify) {
        for (const q of quotes) {
          const corpus = await corpusFor(c.source && c.source.session);
          if (!corpus) { reasons.push(`找不到会话 ${c.source && c.source.session}`); break; }
          if (!norm(corpus).includes(norm(q.text))) {
            reasons.push(`引文未命中原文: 「${truncate(q.text, 28)}」`);
          }
        }
      }
      if (reasons.length) {
        rejects.push({ file: f, id: c.id || "-", reasons, problems });
      } else {
        allCards.push({ ...c, status: "active", createdAt: c.createdAt || Date.now() });
        if (problems.length) rejects.push({ file: f, id: c.id, reasons: [], problems, soft: true });
      }
    }
  }

  // 概念自动补全：卡片引用了但没给定义的概念，先建占位
  const conceptIds = new Set(allConcepts.map((c) => c.id));
  for (const c of allCards) {
    if (!conceptIds.has(c.conceptId)) {
      allConcepts.push({
        id: c.conceptId, name: c.conceptId, domain: "未归类", problem: "",
        lane: c.lane, desc: "", level: 1
      });
      conceptIds.add(c.conceptId);
    }
  }

  // 卡片上限：默认 50（用户定）。到上限不是悄悄丢旧卡，而是让这次入库失败、先淘汰再进。
  let cardLimit = 50;
  try { cardLimit = Number(JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).cardLimit) || 50; } catch {}
  // 上限只管「没学会」的池子：已会的卡默认隐藏、不占 50 个名额；复习答错会自己回到池里（可轮训）。
  const knownConcepts = new Set(db.prepare("SELECT concept_id FROM concept_state WHERE state='known'").all().map((r) => r.concept_id));
  const existing = db.prepare("SELECT id, concept_id FROM card WHERE status='active'").all();
  const activePool = new Set(existing.filter((r) => !knownConcepts.has(r.concept_id)).map((r) => r.id));
  for (const c of allCards) if (!knownConcepts.has(c.conceptId)) activePool.add(c.id);
  if (activePool.size > cardLimit) {
    // 卡片池满了先把这次已验证的知识写进本地知识缓存，再报错退出；知识不因上限丢掉。
    try {
      for (const c of allCards) logCardEntry(db, c, { origin: "ingest", status: "active" });
    } catch { /* 缓存写失败不改变退出码 */ }
    console.error(`未学卡片上限 ${cardLimit}：现有/本次合计 ${activePool.size} 张。先归档或淘汰旧卡，再重跑 ingest。（已验证的 ${allCards.length} 条已存入知识缓存）`);
    process.exit(1);
  }

  upsertConcepts(db, allConcepts);
  upsertCards(db, allCards);
  if (allEdges.length) {
    const valid = allEdges.filter((e) => conceptIds.has(e.from) && conceptIds.has(e.to)
      && ["prereq", "cause", "contrast", "same"].includes(e.kind));
    upsertEdges(db, valid);
  }

  try { syncCardsToKbLog(db); } catch { /* 知识缓存同步失败不挡入库 */ }

  const dbCounts = {
    concepts: db.prepare("SELECT COUNT(*) c FROM concept").get().c,
    edges: db.prepare("SELECT COUNT(*) c FROM edge").get().c,
    cards: db.prepare("SELECT COUNT(*) c FROM card").get().c
  };
  const report = {
    at: new Date().toISOString(),
    db: opt.db,
    cardLimit,
    activePool: activePool.size,
    accepted: allCards.length,
    dbCounts,
    rejected: rejects.filter((r) => !r.soft).length,
    softWarnings: rejects.filter((r) => r.soft).length,
    concepts: dbCounts.concepts,
    edges: dbCounts.edges,
    byLane: allCards.reduce((m, c) => (m[c.lane] = (m[c.lane] || 0) + 1, m), {}),
    rejects
  };
  ensureDir(path.join(ROOT, "data"));
  fs.writeFileSync(path.join(ROOT, "data", "ingest-report.json"), JSON.stringify(report, null, 2));

  console.log(`accepted ${report.accepted} cards  (rejected ${report.rejected}, warnings ${report.softWarnings})`);
  console.log(`concepts ${report.concepts}  edges ${report.edges}  byLane ${JSON.stringify(report.byLane)}`);
  for (const r of rejects.slice(0, 10)) {
    const tag = r.soft ? "WARN" : "REJECT";
    console.log(`${tag} ${r.id}: ${[...(r.reasons || []), ...(r.problems || [])].join("; ")}`);
  }
  console.log(`report -> data/ingest-report.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
