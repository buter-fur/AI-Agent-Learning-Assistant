/**
 * whisper — 实时嗅探的"决策脑"：把一条信号（报错 / 追问 / 收口）变成
 * 「现在弹哪张卡，还是只出角标，还是先别弹」。
 */
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./db.mjs";
import { contentScore, timingScore, historyFreshness, THRESHOLDS } from "./value.mjs";
import { search as kbSearch, thresholds as kbThresholds } from "./kb.mjs";
import { judgeGray } from "./judge.mjs";

/** 常见英文报错 → 中文概念词，让"EADDRINUSE"能匹配到"端口"卡 */
const ALIAS = [
  [/EADDRINUSE|address already in use/i, " 端口 被占用 进程 "],
  [/ECONNREFUSED|connection refused/i, " 连接 服务 没启动 "],
  [/ModuleNotFound|Cannot find module|No module named/i, " 模块 依赖 找不到 "],
  [/permission denied|EACCES/i, " 权限 拒绝 "],
  [/timeout|timed out/i, " 超时 网络 "],
  [/404|Not Found/i, " 接口 路径 找不到 "],
  [/Team ID|code ?sign|证书|签名/i, " 证书 签名 "],
  [/CORS|cross-origin/i, " 跨域 接口 "],
  [/OutOfMemory|heap out of memory/i, " 内存 不够 "]
];
const aliased = (text) => {
  let t = String(text || "");
  for (const [re, zh] of ALIAS) if (re.test(t)) t += zh;
  return t;
};

const CJK = /[^\u4e00-\u9fa5a-z0-9]/gi;
const bigrams = (s) => {
  const t = String(s || "").replace(CJK, "").toLowerCase();
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
};
const overlap = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  if (n < 2) return 0;
  return n / (A.size + B.size - n);
};

export function loadConcepts(db) {
  const map = {};
  for (const c of db.prepare("SELECT * FROM concept").all()) map[c.id] = c;
  return map;
}

/** 只取"这张卡的关键词"来算覆盖率，不拿整段正文稀释 */
function keyText(card, concept) {
  return [
    concept ? concept.name : "", concept ? concept.problem : "",
    card.title, card.takeaway,
    (card.terms || []).map((t) => t.term).join(" ")
  ].join(" ");
}

/** 在现有卡片里找最贴的一条。 */
export function matchCard(db, signal) {
  const concepts = loadConcepts(db);
  const cards = db.prepare("SELECT * FROM card WHERE status='active'").all().map((r) => ({
    id: r.id, lane: r.lane, conceptId: r.concept_id, title: r.title, scene: r.scene,
    question: r.question, options: JSON.parse(r.options_json), answerIndex: r.answer_index,
    answer: r.answer, metaphor: r.metaphor, explain: r.explain,
    terms: JSON.parse(r.terms_json || "[]"), takeaway: r.takeaway,
    boundary: r.boundary_json ? JSON.parse(r.boundary_json) : null,
    figure: r.figure_json ? JSON.parse(r.figure_json) : null,
    quiz: JSON.parse(r.quiz_json || "[]"),
    source: JSON.parse(r.source_json || "{}"),
    crossProject: JSON.parse(r.cross_json || "[]")
  }));

  const text = aliased(signal.text);
  const signalSet = bigrams(text);
  // 学会的卡片默认隐藏（用户 2026-11-14 定）：不参与实时快速命中，回看交给每周温故。
  const learned = new Set(db.prepare("SELECT concept_id FROM concept_state WHERE state='known'").all().map((r) => r.concept_id));
  let best = null;
  for (const card of cards) {
    if (learned.has(card.conceptId)) continue;
    const concept = concepts[card.conceptId];
    // 加权关键词：概念名/术语 3 分、问题 2 分、标题与所以句 1 分
    const weighted = new Map();
    const add = (txt, w) => {
      for (const k of bigrams(txt)) weighted.set(k, Math.max(weighted.get(k) || 0, w));
    };
    if (concept) { add(concept.name, 3); add(concept.problem, 2); }
    add(card.title, 1);
    add(card.takeaway, 1);
    for (const t of card.terms || []) add(t.term, 3);

    let got = 0, total = 0, strong = 0;
    for (const [k, w] of weighted) {
      total += w;
      if (signalSet.has(k)) { got += w; if (w >= 3) strong++; }
    }
    let sim = total ? got / total : 0;
    if (concept && concept.name && text.includes(concept.name)) sim += 0.1;
    if (signal.sessionId && (card.source.session || "").startsWith(String(signal.sessionId).slice(0, 12))) sim += 0.08;
    if (strong === 0 && sim < 0.15) sim = 0;          // 没有命中任何强关键词时，要求整体更像
    const matched = [];
    if (concept && concept.name && text.includes(concept.name)) matched.push(concept.name);
    for (const t of card.terms || []) if (t.term && text.includes(t.term)) matched.push(t.term);
    if (card.title && (text.includes(card.title) || overlap(card.title, text) >= 0.25)) matched.push(card.title);
    if (!matched.length) {
      for (const [k, w] of weighted) if (signalSet.has(k) && w >= 3) matched.push(k);
    }
    const uniqueMatched = [...new Set(matched)].slice(0, 5);
    if (!best || sim > best.sim) best = { card, concept, sim, strong, matched: uniqueMatched };
  }
  return best;
}

/** 决定这次要不要打扰、以什么形式。 */
function pickWorkflow(db, text) {
  const rows = db.prepare("SELECT * FROM card WHERE status='active' AND shape='workflow'").all();
  if (!rows.length) return null;
  const t = aliased(text);
  const set = bigrams(t);
  let best = null;
  const learned = new Set(db.prepare("SELECT concept_id FROM concept_state WHERE state='known'").all().map((x) => x.concept_id));
  for (const r of rows) {
    if (learned.has(r.concept_id)) continue;
    const wf = r.workflow_json ? JSON.parse(r.workflow_json) : {};
    // 场景名直接命中 → 强信号；否则看场景描述的覆盖率
    let score = 0;
    for (const sc of wf.scenarios || []) {
      if (sc.name && t.includes(sc.name)) score = Math.max(score, 0.85);
      const keys = bigrams(sc.name + " " + sc.desc);
      let hits = 0;
      for (const k of keys) if (set.has(k)) hits++;
      if (hits >= 3) score = Math.max(score, Math.min(0.7, hits / Math.max(6, keys.size)));
    }
    if (r.title && t.includes(r.title)) score = Math.max(score, 0.9);
    if (!best || score > best.sim) best = { card: r, sim: score };
  }
  return best && best.sim >= 0.15 ? { card: best.card, sim: best.sim } : null;
}

export async function decide(db, signal) {
  if (signal.kind === "milestone") {
    const wf = pickWorkflow(db, signal.text);
    if (!wf) return { tier: "none", reason: "收口信号，但没有匹配到工作流卡" };
    return { tier: "pop", card: wf.card, concept: null, sim: wf.sim, final: 0.8,
      reason: `工作流 · 匹配 ${wf.sim.toFixed(2)}`,
      why: `这是阶段收口信号；工作流卡「${wf.card.title}」的场景/步骤和它最接近（匹配度 ${wf.sim.toFixed(2)}），所以现在给你看它。` };
  }
  const hit = matchCard(db, signal);
  // 主动扫描：卡片没命中时只查一次知识库做 novelty 判断；命不中就排队做种子卡。
  // 不调本地/云端模型做判定，保持低开销。
  if (signal.kind === "proactive" && (!hit || hit.sim < 0.12)) {
    const kbItems = await kbSearch(signal.text, 3);
    const top = kbItems && kbItems[0];
    if (top && Number(top.score) >= kbThresholds().gate) {
      return { tier: "none", reason: `主动扫描：知识库已有相近内容（${top.score.toFixed(2)}）`, sim: hit ? hit.sim : 0 };
    }
    return {
      tier: "none", sim: hit ? hit.sim : 0,
      seed: true, seedText: signal.text,
      reason: "主动扫描：发现新知识点，排队做种子卡",
      why: `现场里出现了新知识点；现有卡片最高只到 ${hit ? hit.sim.toFixed(2) : "0.00"}${top ? `，知识库最高 ${Number(top.score).toFixed(2)}` : "，知识库也没有足够相近的条目"}，所以先做一张种子卡。`
    };
  }
  if (!hit || hit.sim < 0.12) {
    // 卡片没命中 → 问知识库；≥0.60 直接弹；0.35–0.60 交本地模型判，判中只出角标
    // 卡片已覆盖的知识不再从 KB 重复出：KB 只补「还没做成卡」的内容
    const cardKbIds = new Set(db.prepare("SELECT id FROM card WHERE status='active'").all().map((r) => "kb_" + r.id));
    const kbItems = (await kbSearch(signal.text, 8)).filter((it) => !cardKbIds.has(it.id));
    const top = kbItems[0];
    const th = kbThresholds();
    if (top && top.score >= th.pop) {
      return {
        tier: "pop", kb: top, sim: hit ? hit.sim : 0, final: top.score,
        reason: `知识库 · ${top.title} · ${top.score.toFixed(2)}`,
        why: `知识库里「${top.title}」和现场最接近（相似度 ${top.score.toFixed(2)}，达到弹出阈值 ${th.pop.toFixed(2)}）；它不是已有卡片，先给你看这条。`
      };
    }
    if (top && top.score >= th.gate) {
      const j = await judgeGray({ text: signal.text, item: top });
      if (j && j.match) {
        return {
          tier: "badge", kb: top, sim: hit ? hit.sim : 0, final: top.score,
          reason: `灰区 ${top.score.toFixed(2)} · 本地模型判相关（${j.reason || "能回答"}）`,
          why: `知识库相似度 ${top.score.toFixed(2)} 落在灰区；模型判断「${top.title}」能回答现场（${j.reason || "能回答"}），所以先出角标，不打断你。`
        };
      }
      return {
        tier: "none",
        reason: j
          ? `灰区 ${top.score.toFixed(2)} · 本地模型判不相关（${j.reason || "答非所问"}）`
          : `灰区 ${top.score.toFixed(2)} · 本地模型没起或超时，先不出`,
        sim: hit ? hit.sim : 0
      };
    }
    return {
      tier: "none",
      reason: "没有匹配的卡或知识",
      sim: hit ? hit.sim : 0
    };
  }

  const { card, concept } = hit;
  const content = contentScore(card).content;
  const stRow = db.prepare("SELECT state FROM concept_state WHERE concept_id=?").get(card.conceptId);
  const stage = stRow ? stRow.state : "unknown";
  const hist = historyFreshness(db, card.id);
  const timing = timingScore({
    freshness: hist.freshness,
    justRecurred: signal.kind === "error" || signal.kind === "why",
    justAskedWhy: signal.kind === "why"
  });
  const final = content * (0.55 + 0.45 * timing);
  let tier = final >= THRESHOLDS.pop ? "pop" : final >= THRESHOLDS.badge ? "badge" : "pool";

  // 弱匹配只允许角标，不允许直接弹（防误报打扰）
  if (hit.sim < 0.12 && tier === "pop") tier = "badge";
  const matchedText = hit.matched && hit.matched.length
    ? `共同关键词：${hit.matched.join("、")}。`
    : "没有共享关键词，是整体语义最接近。";
  const why = `你在现场提到的内容和卡片「${card.title}」最接近；${matchedText}匹配度 ${hit.sim.toFixed(2)}（词面重合）。综合价值 ${final.toFixed(2)} = 内容 ${content.toFixed(2)} × 时机 ${timing.toFixed(2)}，${tier === "pop" ? `达到弹出阈值 ${THRESHOLDS.pop.toFixed(2)}` : `只达到角标阈值 ${THRESHOLDS.badge.toFixed(2)}，先放在角标里`}。`;
  return {
    tier: tier === "pool" ? "none" : tier,
    card, concept, stage, sim: hit.sim, content, timing, final, matched: hit.matched || [], why,
    reason: `${concept ? concept.name : card.conceptId} · 匹配 ${hit.sim.toFixed(2)} · 内容 ${content.toFixed(2)} · 时机 ${timing.toFixed(2)}（记忆 ${hist.S.toFixed(1)} 天） · 价值 ${final.toFixed(2)}`
  };
}
