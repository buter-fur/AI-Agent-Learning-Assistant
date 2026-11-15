#!/usr/bin/env node
/**
 * review — 重复/复习调度器：用「价值 × 遗忘风险」决定今天推哪几张。
 *
 * 不复用 Anki 的固定档位，而是：
 *   可提取概率 R(t) = exp(-t / S)        S = 记忆稳定度（天），复习对了 S 变大
 *   应重现值   P    = V × (1 - R)         V = 内容价值（来自 value.mjs）
 * 每天：
 *   · 复习位 3 个：P ≥ 0.30 的按 P 排序取前 3
 *   · 新卡位 2 个：V 最高的未读卡
 *   · 重逢位 1 个：不占预算（情境已经到了，成本≈0），只给一句话版
 * 低价值卡（V < 0.55）永远不进复习位，只在重逢时提一句。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./db.mjs";
import { contentScore, MEMORY } from "./value.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const POLICY = {
  reviewSlots: 3, newSlots: 2, pThreshold: 0.3, lowValue: 0.55,
  S0: MEMORY.S0, grow: MEMORY.grow, shrink: MEMORY.shrink, SMax: MEMORY.SMax
};

export function makeState(cards) {
  return cards.map((c) => ({
    card: c, value: contentScore(c).content,
    S: POLICY.S0, last: -99, reps: 0, hits: 0
  }));
}

export function retrievability(item, day) {
  const t = Math.max(0, day - item.last);
  return Math.exp(-t / item.S);
}

export function planDay(state, day) {
  const fresh = state.filter((s) => s.last < 0).sort((a, b) => b.value - a.value);
  const seen = state.filter((s) => s.last >= 0);
  const due = seen
    .map((s) => ({ s, P: s.value * (1 - retrievability(s, day)) }))
    .filter((x) => x.P >= POLICY.pThreshold && x.s.value >= POLICY.lowValue)
    .sort((a, b) => b.P - a.P)
    .slice(0, POLICY.reviewSlots);
  const picks = [...due.map((x) => ({ item: x.s, why: `复习 P=${x.P.toFixed(2)}` }))];
  for (const s of fresh.slice(0, POLICY.newSlots)) picks.push({ item: s, why: "新卡" });
  return picks;
}

export function record(item, day, correct) {
  item.last = day;
  item.reps += 1;
  if (correct) {
    item.hits += 1;
    item.S = Math.min(POLICY.SMax, item.S * POLICY.grow);
  } else {
    item.S = Math.max(1, item.S * POLICY.shrink);
  }
}

function loadCards() {
  const db = new DatabaseSync(dbPath(ROOT));
  return db.prepare("SELECT * FROM card WHERE status!='rejected'").all().map((r) => ({
    id: r.id, lane: r.lane, conceptId: r.concept_id, title: r.title,
    scene: r.scene, metaphor: r.metaphor, explain: r.explain, takeaway: r.takeaway,
    figure: r.figure_json ? JSON.parse(r.figure_json) : null,
    boundary: r.boundary_json ? JSON.parse(r.boundary_json) : null,
    quiz: JSON.parse(r.quiz_json || "[]"), source: JSON.parse(r.source_json || "{}"),
    crossProject: JSON.parse(r.cross_json || "[]")
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const days = Number(process.argv[2] || 14);
  const state = makeState(loadCards());
  const appearances = new Map(state.map((s) => [s.card.id, []]));
  for (let d = 0; d < days; d++) {
    for (const { item, why } of planDay(state, d)) {
      appearances.get(item.card.id).push(d);
      record(item, d, true);
    }
  }
  const rows = state.map((s) => ({
    v: s.value, title: s.card.title, days: appearances.get(s.card.id)
  })).sort((a, b) => b.v - a.v);
  console.log(`模拟 ${days} 天（假设每次都答对，只看价值与间隔的作用）\n`);
  for (const r of rows) {
    console.log(`${r.v.toFixed(2)}  ${String(r.days.length).padStart(2)} 次  ${r.days.length ? "第 " + r.days.map((d) => d + 1).join("/") + " 天" : "从不"}   ${r.title}`);
  }
  const hi = rows.filter((r) => r.v >= 0.85), lo = rows.filter((r) => r.v < 0.85);
  const avg = (a) => (a.reduce((n, r) => n + r.days.length, 0) / (a.length || 1)).toFixed(1);
  console.log(`\n高价值组(V≥0.85) 平均出现 ${avg(hi)} 次；其余组 平均 ${avg(lo)} 次`);
}
