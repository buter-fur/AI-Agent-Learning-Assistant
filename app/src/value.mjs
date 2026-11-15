#!/usr/bin/env node
/**
 * value — 卡片"值不值得现在弹"的评分器（纯规则，不调模型）。
 *
 * 两层分：
 *   内容分 content = 这张卡本身值不值得学（跨项目性 / 证据 / 可执行性 / 不是操作说明）
 *   时机分 timing  = 现在值不值得打断（没讲过 / 刚又撞上 / 刚问过为什么 / 最近看过几次）
 *   最终分 final   = content × (0.55 + 0.45 × timing)   ← 内容分是上限，时机分只决定打几折
 * 阈值：≥0.72 立即弹 / 0.58–0.72 只出小角标 / <0.58 进待定池
 * 数量不是主判据，只是安全阀（见 README「额度」一节）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./db.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const THRESHOLDS = { pop: 0.72, badge: 0.58 };
/** 记忆稳定度参数：和 review.mjs 共用同一份，别各写一套。 */
export const MEMORY = { S0: 1.6, grow: 2.1, shrink: 0.7, SMax: 60 };
const OP_TITLE = /如何|步骤|怎么装|安装|配置|启动|新建|删除/;
const ACTION_WORDS = /以后|下次|先|别急|记得|不要/;
const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * 从真实复习记录算「现在有多该再遇到一次」：
 *   R = exp(-t / S)，freshness = 1 - R
 * 答对 S 变大（越记越牢，间隔拉长），答错 S 变小（很快再来）。
 * 没复习过时给 1（第一次最该讲）。
 */
export function historyFreshness(db, cardId, now = Date.now()) {
  const rows = db.prepare("SELECT action, correct, ts FROM review WHERE card_id=? ORDER BY ts ASC").all(cardId);
  if (!rows.length) return { freshness: 1, seen: 0, S: MEMORY.S0, days: null };
  let S = MEMORY.S0;
  for (const r of rows) {
    const ok = r.action === "got" || r.action === "too-easy" || (r.action === "quiz" && Number(r.correct) === 1);
    const bad = r.action === "nope" || (r.action === "quiz" && Number(r.correct) === 0);
    if (ok) S = Math.min(MEMORY.SMax, S * MEMORY.grow);
    else if (bad) S = Math.max(1, S * MEMORY.shrink);
  }
  const last = rows[rows.length - 1].ts || now;
  const days = Math.max(0, (now - last) / 86400000);
  const R = Math.exp(-days / S);
  return { freshness: clamp01(1 - R), seen: rows.length, S, days };
}

export function contentScore(card, ctx = {}) {
  const quotes = (card.source && card.source.quotes) || [];
  const hasAssistant = quotes.some((q) => q.who === "assistant");
  const evidence = clamp01(
    Math.min(1, quotes.length / 2) * 0.45 +
    (card.figure ? 0.3 : 0) +
    (hasAssistant ? 0.25 : 0)
  );

  const cross = (card.crossProject || []).length;
  const laneBase = card.lane === "judgment" ? 0.8 : card.lane === "mechanism" ? 0.7
    : card.lane === "algorithm" ? 0.7 : 0.55;
  const transfer = clamp01(cross >= 2 ? 0.95 : cross === 1 ? 0.8 : laneBase);

  const actionability = clamp01(
    (ACTION_WORDS.test(card.takeaway || "") ? 0.65 : 0.25) +
    (card.boundary ? 0.2 : 0) +
    ((card.quiz || []).length >= 2 ? 0.15 : 0)
  );

  let penalty = 0;
  if (OP_TITLE.test(card.title || "")) penalty += 0.35;
  if (!card.takeaway) penalty += 0.3;
  if (/你当时|你连续|失败了\d/.test([card.scene, card.explain, card.metaphor].join(""))) penalty += 0.4;

  const nonRoutine = clamp01(1 - penalty);
  const content = clamp01(0.28 * evidence + 0.24 * transfer + 0.22 * actionability + 0.26 * nonRoutine);
  return { content, parts: { evidence, transfer, actionability, nonRoutine } };
}

export function timingScore(ctx = {}) {
  // 没讲过=1；之后按遗忘曲线：距上次越久、越该再遇到一次。
  const seen = ctx.seenRecently || 0;
  const freshness = ctx.freshness != null
    ? clamp01(ctx.freshness)
    : [1, 0.55, 0.3, 0.12][Math.min(seen, 3)];
  const t = 0.5 * freshness
    + 0.3 * (ctx.justRecurred ? 1 : 0)
    + 0.2 * (ctx.justAskedWhy ? 1 : 0);
  return clamp01(t);
}

export function scoreCard(card, ctx = {}) {
  const { content, parts } = contentScore(card, ctx);
  const timing = ctx.timing != null ? clamp01(ctx.timing) : timingScore(ctx);
  const final = clamp01(content * (0.55 + 0.45 * timing));
  const tier = final >= THRESHOLDS.pop ? "pop" : final >= THRESHOLDS.badge ? "badge" : "pool";
  return { content, timing, final, tier, parts };
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
  const cards = loadCards();
  const rows = cards.map((c) => ({ c, r: scoreCard(c, { timing: 1 }) }))
    .sort((a, b) => b.r.content - a.r.content);
  console.log('内容分排序（时机按第一次遇到 = 1.0 算）\n');
  console.log("content  弹(1st)  2nd   3rd   线   标题");
  for (const { c, r } of rows) {
    const first = r.final;
    const second = r.content * (0.55 + 0.45 * 0.55);
    const third = r.content * (0.55 + 0.45 * 0.3);
    console.log(
      `${r.content.toFixed(2)}    ${first.toFixed(2)}   ${second.toFixed(2)} ${third.toFixed(2)}  ${c.lane.padEnd(9)} ${c.title}`
    );
  }
  const spread = (k) => {
    const v = rows.map((x) => x.r[k]);
    return `${Math.min(...v).toFixed(2)}–${Math.max(...v).toFixed(2)}`;
  };
  console.log(`\n内容分布 ${spread("content")}；共 ${rows.length} 张`);
  console.log(`阈值：立即弹 ≥${THRESHOLDS.pop} / 小角标 ≥${THRESHOLDS.badge} / 其余进池`);
}
