#!/usr/bin/env node
/**
 * packet — 把候选时刻切成"提炼包"（markdown），给模型/agent 做卡片用。
 * 零 LLM 成本；每包上限 ~5k 字符，附产出要求。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, truncate } from "./util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUOTA = { mechanism: 40, syntax: 40, algorithm: 12, judgment: 12 };

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

export function packetFor(c, tight) {
  const uCap = tight ? 400 : 900;
  const aCap = tight ? 600 : 1400;
  const eCap = tight ? 300 : 700;
  const L = [];
  L.push(`# 候选 ${c.id}`);
  L.push("");
  L.push(`- 线：**${c.lane}**　项目：**${c.project}**　时间：${c.timeText}`);
  L.push(`- 会话：\`${c.sessionId}\`　turn：${c.turn}　seq：${c.seqStart}–${c.seqEnd}`);
  L.push(`- 信号：${c.signals.join(", ")}　规则分：${c.score}`);
  L.push("");
  if (c.userText && c.userText.length) {
    L.push("## 用户在这一轮说的（逐字）");
    for (const u of c.userText) L.push(`> ${truncate(u.text, uCap)}`);
    L.push("");
  }
  if (c.lane === "syntax" && c.edits && c.edits.length) {
    L.push("## 这一轮的代码改动（语法线素材，优先看这个）");
    for (const e of c.edits) {
      L.push(`### \`${e.file}\`  (${e.tool}, seq ${e.seq})`);
      if (e.old) L.push("旧：", "```", truncate(e.old, tight ? 260 : 700), "```");
      if (e.new) L.push("新：", "```", truncate(e.new, tight ? 380 : 900), "```");
      L.push("");
    }
  }
  if (c.assistantText && c.assistantText.length) {
    L.push("## 助手最终怎么讲的（逐字，可当素材）");
    for (const a of c.assistantText) L.push(`> ${truncate(a.text, aCap)}`, "");
  }
  if (c.errors && c.errors.length) {
    L.push("## 报错原文");
    for (const e of c.errors) L.push("```", `code=${e.code || "-"} name=${e.name || "-"} seq=${e.seq}`, truncate(e.text, eCap), "```", "");
  }
  if (c.lane !== "syntax" && c.edits && c.edits.length) {
    L.push("## 这一轮的代码改动");
    for (const e of c.edits) {
      L.push(`### \`${e.file}\`  (${e.tool}, seq ${e.seq})`);
      if (e.old) L.push("旧：", "```", truncate(e.old, tight ? 260 : 700), "```");
      if (e.new) L.push("新：", "```", truncate(e.new, tight ? 380 : 900), "```");
      L.push("");
    }
  }
  if (c.memories && c.memories.length) {
    L.push("## 助手当时已自己总结过（可直接复用）");
    for (const m of c.memories) L.push(`- ${truncate(m.content, 300)}`);
    L.push("");
  }
  if (c.decisions && c.decisions.length) {
    L.push("## 决策点");
    for (const d of c.decisions) L.push(`- ${d.kind}: ${truncate(d.q || d.selected || "", 500)}`);
    L.push("");
  }
  L.push("---");
  L.push("## 产出要求");
  L.push("按 `docs/CONTRACT.md` 的 Card 结构产出 0–2 张卡（宁可 0 张，不要凑数）。要求：");
  L.push("1. 只讲一件事，主概念 1 个；标题用「他的问题」，不用知识点名。");
  L.push("2. 先比喻、再术语、最后一句「以后看到 X 先想到 Y」。");
  L.push("3. 引文必须逐字来自上面原文；写不出就放弃这张卡。");
  L.push("4. 若这条素材更适合别的线（比如其实是判断卡），直接换 lane 并说明。");
  return L.join("\n");
}

function main() {
  const inFile = path.resolve(arg("--in", path.join(ROOT, "data", "candidates.json")));
  const outDir = path.resolve(arg("--out", path.join(ROOT, "data", "packets")));
  const data = JSON.parse(fs.readFileSync(inFile, "utf8"));
  const byLane = {};
  for (const c of data.candidates) {
    (byLane[c.lane] = byLane[c.lane] || []).push(c);
  }
  ensureDir(outDir);
  for (const f of fs.readdirSync(outDir)) if (f.endsWith(".md")) fs.unlinkSync(path.join(outDir, f));

  const index = [];
  let n = 0;
  for (const [lane, quota] of Object.entries(QUOTA)) {
    const list = (byLane[lane] || []).slice(0, quota);
    for (const c of list) {
      let body = packetFor(c, false);
      if (body.length > 7000) body = packetFor(c, true);
      if (body.length > 8200) body = body.slice(0, 8200) + "\n\n…（已截断）";
      const file = path.join(outDir, `${c.id}.md`);
      fs.writeFileSync(file, body);
      index.push({ id: c.id, lane, project: c.project, time: c.timeText, score: c.score, file: path.basename(file), chars: body.length });
      n++;
    }
  }
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify({ generatedAt: Date.now(), count: n, packets: index }, null, 2));
  console.log(`packets: ${n} -> ${outDir}`);
  const byL = index.reduce((m, p) => (m[p.lane] = (m[p.lane] || 0) + 1, m), {});
  console.log(`by lane: ${JSON.stringify(byL)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
