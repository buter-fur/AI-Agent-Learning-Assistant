#!/usr/bin/env node
/**
 * qa — 对已入库（或某个 batch 文件）的卡片做质量体检。
 * 只报告，不改数据。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./db.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };

const len = (s) => [...String(s || "")].length;
const bigrams = (s) => {
  const t = String(s || "").replace(/[^\u4e00-\u9fa5a-z0-9]/gi, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
};
const jaccard = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
};

function loadCards() {
  const file = arg("--batch", "");
  if (file) {
    const j = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    return Array.isArray(j) ? j : j.cards || [];
  }
  const db = new DatabaseSync(dbPath(ROOT));
  return db.prepare("SELECT * FROM card WHERE status!='rejected'").all().map((r) => ({
    id: r.id, lane: r.lane, conceptId: r.concept_id, level: r.level, title: r.title,
    scene: r.scene, question: r.question, options: JSON.parse(r.options_json), answerIndex: r.answer_index,
    answer: r.answer, metaphor: r.metaphor, explain: r.explain, terms: JSON.parse(r.terms_json),
    takeaway: r.takeaway, figure: r.figure_json ? JSON.parse(r.figure_json) : null,
    quiz: JSON.parse(r.quiz_json || "[]"), source: JSON.parse(r.source_json || "{}"),
    shape: r.shape || "concept"
  }));
}

const cards = loadCards();
const issues = [];
const warn = (c, msg) => issues.push({ id: c.id, msg });

for (const c of cards) {
  if (len(c.title) > 18) warn(c, `标题 ${len(c.title)} 字`);
  if (len(c.scene) > 80) warn(c, `场景 ${len(c.scene)} 字`);
  if (len(c.question) > 40) warn(c, `问题 ${len(c.question)} 字`);
  if (len(c.explain) > 140) warn(c, `讲明白 ${len(c.explain)} 字`);
  if (len(c.takeaway) > 50) warn(c, `所以句 ${len(c.takeaway)} 字`);
  const total = ["title", "scene", "question", "metaphor", "explain", "takeaway"].reduce((n, k) => n + len(c[k]), 0);
  if (total > 320) warn(c, `总字数 ${total}`);
  const isWorkflow = c.shape === "workflow";
  if (!isWorkflow) {
    if (!c.options.includes("我不知道")) warn(c, "缺「我不知道」");
    if (c.options[c.answerIndex] === "我不知道") warn(c, "答案指向「我不知道」");
  }
  if (c.lane === "syntax" && !c.figure) warn(c, "语法卡没有代码图");
  if (/你当时|你连续|你怎么连|失败了\d|搞挂/.test([c.scene, c.explain, c.metaphor].join(""))) warn(c, "第二人称失败叙述");
  if (/[A-Za-z0-9]{1,}/.test(c.title) && /:\d|端口|\.js|\.py|deepseek/i.test(c.title)) warn(c, "标题含具体实现细节");
  for (const q of c.quiz || []) {
    if (jaccard(q.q, c.question) > 0.72) warn(c, `变式题与卡面问题太像: ${q.q.slice(0, 18)}…`);
    if (!Array.isArray(q.options) || q.options.length < 2) warn(c, "变式题选项 <2");
    if (q.answerIndex == null) warn(c, "变式题缺答案");
  }
  if (!isWorkflow && !(c.source.quotes || []).length) warn(c, "没有原文引文");
}

// 概念重复：同一概念多张卡（不一定是错，但要看一眼）
const byConcept = {};
for (const c of cards) (byConcept[c.conceptId] = byConcept[c.conceptId] || []).push(c.title);

const byLane = cards.reduce((m, c) => (m[c.lane] = (m[c.lane] || 0) + 1, m), {});
console.log(`cards ${cards.length}  byLane ${JSON.stringify(byLane)}`);
console.log(`concepts ${Object.keys(byConcept).length}`);
const dup = Object.entries(byConcept).filter(([, v]) => v.length > 1);
if (dup.length) console.log(`一概念多卡: ${dup.map(([k, v]) => `${k}×${v.length}`).join(", ")}`);
const noFig = cards.filter((c) => !c.figure).length;
console.log(`无图 ${noFig} / ${cards.length}；平均变式题 ${(cards.reduce((n, c) => n + (c.quiz || []).length, 0) / cards.length).toFixed(1)} 道`);

if (issues.length) {
  console.log(`\n--- 问题 ${issues.length} 条 ---`);
  for (const i of issues.slice(0, 40)) console.log(`${i.id}\n   ${i.msg}`);
} else {
  console.log("\n没有问题。");
}
