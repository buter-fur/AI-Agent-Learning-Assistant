#!/usr/bin/env node
/**
 * export-kb-doc — 把现有卡片库导出成一份「知识库基础文档」doc.md。
 * 输出符合 知识库内容标准-v0.1：标题≤18、有引文、有来源锚点、有所以句。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "../src/db.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let TAGMAP = { map: {} };
try { TAGMAP = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "tag-map.json"), "utf8")); } catch {}
// 本地模型（tools/local_tag.py）打好的标签，重新生成 doc.md 时不能丢
let OVERRIDES = {};
try { OVERRIDES = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "tag-overrides.json"), "utf8")); } catch {}
const overrideTags = (id) => {
  const ov = OVERRIDES[id] || OVERRIDES[String(id).replace(/^kb_/, "")] || OVERRIDES["kb_" + id];
  return Array.isArray(ov) && ov.length ? ov.slice(0, 5) : null;
};
const mapTags = (tags) => {
  const out = [];
  for (const t of tags || []) {
    const c = (TAGMAP.map && TAGMAP.map[String(t).trim()]) || String(t).trim();
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= 5) break;
  }
  return out;
};
// 归一后不足 2 个标签时，按内容补一个（词表内）
const FALLBACK = [
  [/画面|渲染|0×0|像素/, "页面渲染"], [/证书|签名|keychain|team id/i, "macOS"],
  [/色彩|色域|ICC|ΔE/i, "显示器"], [/碰撞|扫掠|3D|模型/, "游戏开发"],
  [/算法|平方根|定点|进制|乘回|整除/, "算法"], [/插件|重启|宿主|热更新/, "环境与工具"],
  [/档位|预设|参数/, "状态管理"], [/OAuth|认证|密钥|token/i, "安全"],
  [/端口|服务|host/i, "服务与部署"], [/权限|授权/, "权限"],
  [/存储|数据|快照/, "数据存储"], [/测试|验证|断言/, "测试"], [/提示词|角色/, "提示词"],
];
const EXTRA_TAGS = {
  "kb_card-colormatch-icc-measurement": "显示器",
  "kb_card-crowd-rush-double-sqrt": "算法",
  "card-crowd-rush-double-sqrt": "算法",
  "kb_cand-syn-d3007522-t3": "前端交互",
};
const ensureTwo = (tags, e, id) => {
  const out = [...tags];
  const norm = (x) => String(x).replace(/_/g, "-");
  const extra = id ? Object.entries(EXTRA_TAGS).find(([k]) => norm(k) === norm(id))?.[1] : null;
  if (extra && !out.includes(extra)) out.push(extra);
  if (out.length >= 2) return out.slice(0, 5);
  const hay = [e.title, e.summary, e.text].filter(Boolean).join(" ");
  for (const [re, tag] of FALLBACK) {
    if (out.length >= 2) break;
    if (re.test(hay) && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 5);
};
const LANE = { mechanism: "机制", syntax: "语法", algorithm: "算法", judgment: "判断" };

// 人工校订的一句话（≤24 字）；未列出的走启发式
const SUMMARY = {
  "card-crowd-rush-frame-budget": "数字算全量，画面只画 700",
  "card-crowd-rush-measurement-error": "先复现，再怀疑自己的测量",
  "card-example-project-zero-size-window": "接口都通但全白，先查渲染尺寸",
  "card-account-usage-history-reprice": "历史数字不该跟现价重算",
  "card-iclass-notification-denied": "开关开着，不代表系统已授权",
  "card-iclass-mac-signing-cert": "证书类型要和目标平台匹配",
  "card-sillytavern-page-freeze": "服务 200 却连不上，先查页面",
  "card-example-project-crlf-bat": "换行符不同，命令会被截断",
  "card-colormatch-icc-measurement": "ICC 是这台设备的状态记录",
  "card-paper-gladiator-two-status": "列表变了数字没变，找第二份状态",
  "card-mech-05a4c0dc-1": "先数平台插头，别急着重写",
  "card-example-project-port-fallback": "端口被占就试下一个",
  "card-crowd-rush-double-sqrt": "同一个换算可能被做了两次",
  "card-paper-gladiator-state-fingerprint": "指纹里任何一项变，就标旧",
  "card-paper-gladiator-verbatim-quote": "引文要能在原文里逐字命中",
  "card-example-installment-remainder": "除不尽的零头给前几期",
  "card-colormatch-fixed-point": "定点数：写时乘，读时除"
};
const oneSentence = (s) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= 40) return t;
  const cut = t.slice(0, 40);
  const i = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
  return i > 12 ? cut.slice(0, i + 1) : cut;
};
const reQuote = (s) => String(s || "").replace(/\s+/g, " ").trim();
const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
};
const firstClause = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  const m = t.split(/[。；;，,]/)[0] || t;
  return clip(m, n);
};
const trimTo = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const i = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"));
  return (i > n * 0.6 ? cut.slice(0, i + 1) : cut.slice(0, n - 1) + "…");
};

const db = new DatabaseSync(dbPath(path.join(ROOT, "app")));
const rows = db.prepare("SELECT c.*, k.name AS concept_name, k.desc AS concept_desc FROM card c LEFT JOIN concept k ON k.id=c.concept_id WHERE c.status='active' AND c.shape!='workflow' ORDER BY c.lane, c.created_at").all();

const entries = rows.map((r) => {
  const src = JSON.parse(r.source_json || "{}");
  const terms = JSON.parse(r.terms_json || "[]");
  const q = (src.quotes || [])[0] || {};
  let text = trimTo([r.scene, r.explain].filter(Boolean).join(" "), 400);
  if (text.length < 80 && r.concept_desc) text = trimTo(text + " " + r.concept_desc, 400);
  const anchor = src.seq ? `session=${src.session}#seq=${src.seq}` : (src.session ? `session=${src.session}（无 seq）` : "");
  return {
    id: r.id,
    lane: r.lane,
    title: clip(r.title, 18),
    summary: SUMMARY[r.id] || clip(r.takeaway, 24),
    text,
    takeaway: clip(r.takeaway, 60),
    quote: clip(q.text, 90),
    source: [src.project || "未标注", anchor || src.time || ""].filter(Boolean).join(" · "),
    tags: ensureTwo(mapTags([...(terms || []).map((t) => t.term), r.concept_name].filter(Boolean)), { title: r.title, summary: r.title, text: r.text }, r.id),
    concept: r.concept_name || r.concept_id,
    confidence: q.text ? "A" : "B"
  };
});

const wfRow = db.prepare("SELECT * FROM card WHERE shape='workflow' AND status='active' LIMIT 1").get();
const wf = wfRow ? { row: wfRow, data: JSON.parse(wfRow.workflow_json || "{}") } : null;

const now = new Date().toISOString().slice(0, 10);
let md = `# 学习小助手 · 知识库基础文档\n\n`;
md += `> 版本：v0.1（${now}）　来源：现有卡片库导出 + 人工校订　条数：${entries.length} 条知识 + ${wf ? 1 : 0} 条工作流\n`;
md += `> 用途：作为 ChromaDB 的首批入库内容；字段与《知识库内容标准-v0.1》一致。\n`;
md += `> 每条都带「原文引文 + 来源锚点」，前端可用 \`source.anchor\` 做「定位返回」。\n`;
md += `> **切分约定**：一条知识 = 一个 \`###\` 小节；禁止按空行/固定长度切分（见《知识库分片规则-v0.1》）。\n\n`;
md += `---\n\n## 字段说明\n\n`;
md += `| 字段 | 含义 | 约束 |\n|---|---|---|\n`;
md += `| title | 标题 | ≤18 字，不含项目名/端口/函数名 |\n`;
md += `| summary | 一句话点破 | ≤24 字 |\n`;
md += `| text | 正文 | 80–400 字，人话 |\n`;
md += `| quote | 原文引文 | 必须逐字出现在会话原文 |\n`;
md += `| source | 来源锚点 | 项目 · session=…#seq=…；**这就是「定位返回」的锚点** |\n`;
md += `| tags | 检索标签 | 2–5 个 |\n`;
md += `| lane | 学习线 | mechanism / syntax / algorithm / judgment |\n`;
md += `| confidence | 可信度 | A 可核验 / B 有引文未复现 / C 推断 |\n\n`;

let seqNo = 0;
for (const lane of ["mechanism", "syntax", "algorithm", "judgment"]) {
  const list = entries.filter((e) => e.lane === lane);
  if (!list.length) continue;
  md += `---\n\n## ${LANE[lane]}线（${list.length} 条）\n\n`;
  list.forEach((e) => {
    seqNo += 1;
    md += `### ${String(seqNo).padStart(2, "0")} ${e.title}\n\n`;
    md += `- **ID**：kb_${e.id}\n`;
    md += `- **类型**：knowledge　**学习线**：${e.lane}\n`;
    md += `- **一句话**：${e.summary}\n`;
    md += `- **正文**：${e.text}\n`;
    md += `- **原文引文**：「${e.quote || "（无）"}」\n`;
    md += `- **来源**：${e.source || "未标注"}\n`;
    md += `- **标签**：${(overrideTags(e.id) || ensureTwo(mapTags(e.tags), e, e.id)).join("、") || "无"}　**概念**：${e.concept}　**可信度**：${e.confidence}\n`;
    md += `- **所以**：${e.takeaway}\n\n`;
  });
}

if (wf) {
  const d = wf.data;
  md += `---\n\n## 工作流（1 条）\n\n### ${clip(wf.row.title, 18)}\n\n`;
  md += `- **ID**：kb_${wf.row.id}\n`;
  md += `- **类型**：workflow　**学习线**：judgment\n`;
  md += `- **一句话**：先侦察再动手，一次才过\n`;
  md += `- **流程**：${(d.steps || []).map((s, i) => `${i + 1}. ${s.name}（${s.what}）`).join(" → ")}\n`;
  md += `- **决策点**：\n`;
  for (const x of d.decisions || []) md += `  - ${x.q} → 选「${x.choice}」；代价：${x.tradeoff}\n`;
  md += `- **常用场景**：${(d.scenarios || []).map((s) => s.name).join("、")}\n`;
  md += `- **来源**：${(JSON.parse(wf.row.source_json || "{}").project) || "未标注"}（工作流为归纳，无单条引文）\n`;
  const wft = overrideTags("kb_" + wf.row.id);
  if (wft) md += `- **标签**：${wft.join("、")}\n`;
  md += `- **所以**：${wf.row.takeaway}\n\n`;
}

const extraPath = path.join(ROOT, "app", "data", "kb-extra.jsonl");
if (fs.existsSync(extraPath)) {
  const extras = fs.readFileSync(extraPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (extras.length) {
    md += `---\n\n## 知识库补充（${extras.length} 条，本地模型生成后人工校订）\n\n`;
    extras.forEach((e, i) => {
      const id = e.id.startsWith("kb_") ? e.id : "kb_" + e.id.replace(/^kb-/, "");
      md += `### ${String(i + 1).padStart(2, "0")} ${clip(e.title, 18)}\n\n`;
      md += `- **ID**：${id}\n`;
      md += `- **类型**：knowledge　**学习线**：${e.lane}\n`;
      md += `- **一句话**：${oneSentence(e.summary)}\n`;
      md += `- **正文**：${trimTo(e.text, 400)}\n`;
      md += `- **原文引文**：「${reQuote(e.quote)}」\n`;
      md += `- **来源**：${e.source}\n`;
      md += `- **标签**：${(overrideTags(id) || ensureTwo(mapTags(e.tags), e, e.id)).join("、")}　**概念**：补充　**可信度**：${e.confidence || "A"}\n`;
      md += `- **所以**：${e.takeaway}\n\n`;
    });
  }
}

md += `---\n\n## 导入建议（ChromaDB）\n\n`;
md += `- collection：\`learning_kb\`；id 用 \`kb_<卡片id>\`；\n`;
md += `- metadata：\`lane / concept / project / session / anchor / confidence / updatedAt\`；\n`;
md += `- 正文与引文分别存 \`text\` 与 \`quote\`，检索只返回 \`summary + quotePreview\`，点开再拉全文；\n`;
md += `- 卡片库里已有的这些条目，入 KB 时标 \`covered_by_card: <card_id>\`，用于「知识库查到了但卡片已覆盖」的去重。\n`;

const out = path.join(ROOT, "doc.md");
fs.writeFileSync(out, md);

const jsonl = entries.map((e) => JSON.stringify({
  id: "kb_" + e.id, title: e.title, summary: e.summary, text: e.text,
  quote: e.quote, project: e.source.split(" · ")[0], source: e.source,
  tags: e.tags, lane: e.lane, concept: e.concept, confidence: e.confidence,
  covered_by_card: e.id
})).join("\n") + "\n";
fs.writeFileSync(path.join(ROOT, "doc.jsonl"), jsonl);
console.log(`wrote ${out}`);
const shortText = entries.filter((e) => e.text.length < 80).length;
console.log(`entries=${entries.length} workflow=${wf ? 1 : 0} bytes=${Buffer.byteLength(md)}`);
console.log(`text<80: ${shortText}`);
