#!/usr/bin/env node
/**
 * scan — 把 DSH 会话日志投影成"候选学习时刻"。
 * 只做规则打点，零 LLM 成本；重活留给 extract（人工/API 产出卡片）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJsonlSync, listSessionFiles, fmtTime, truncate, ensureDir, projectFromPath
} from "./util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = process.env.WORKSPACE_DIR || process.cwd();
const KNOWN_PROJECTS = (() => {
  try {
    return fs.readdirSync(WORKSPACE, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch { return []; }
})();
function projectFromText(text) {
  if (!text) return "";
  const hit = KNOWN_PROJECTS.find((p) => String(text).includes(p));
  return hit || "";
}

const PERF_RE = /卡顿|很慢|太慢|性能|O\(n|复杂度|内存|爆栈|帧|延迟|超时|加载慢|刷新慢|卡死|占满|几秒/;
const WHY_RE = /为什么|为啥|怎么会|看不懂|没看懂|不明白|没搞清|不对|不是吧|错了|应该是|有没有搞错|啥意思|什么意思/;
const KEEP_EVENT = new Set([
  "user/message", "assistant/message", "tool/call", "tool/result",
  "turn/start", "turn/end", "approval/decided"
]);

function parseArgs(argv) {
  const out = { all: false, minScore: 3, cap: 260, excludeSelf: true, outFile: path.join(ROOT, "data", "candidates.json") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--include-self") out.excludeSelf = false;
    else if (a === "--min-score") out.minScore = Number(argv[++i]);
    else if (a === "--cap") out.cap = Number(argv[++i]);
    else if (a === "--out") out.outFile = path.resolve(argv[++i]);
  }
  return out;
}

function argsOf(call) {
  try {
    return JSON.parse(call.data.arguments || "{}");
  } catch {
    return {};
  }
}

function jsonSafe(v, n = 600) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return truncate(s, n);
}

/**
 * 扫描会话日志，返回候选时刻。CLI 和历史旁听共用这一份规则。
 * @param {object} [input] 覆盖默认参数；也可传 files 限定文件。
 * @returns {Promise<{files:any[], candidates:any[], kept:any[], perFile:any[], opt:object}>}
 */
export async function scanSessions(input = {}) {
  const opt = { all: false, minScore: 3, cap: 260, excludeSelf: true, outFile: path.join(ROOT, "data", "candidates.json"), ...input };
  const files = (opt.files || listSessionFiles()).filter((f) => {
    if (!opt.before) return true;
    try { return (fs.statSync(f.file).mtimeMs || 0) < opt.before; } catch { return false; }
  });
  const candidates = [];
  const perFile = [];

  for (const f of files) {
    let rows;
    try {
      rows = await readJsonlSync(f.file);
    } catch (e) {
      perFile.push({ file: f.file, error: String(e.message || e) });
      continue;
    }
    if (!rows.length) { perFile.push({ file: f.file, events: 0 }); continue; }
    const header = rows[0].type === "session" ? rows[0] : {};
    if (rows.length < 20) { perFile.push({ file: f.file, events: rows.length, skipped: "too-small" }); continue; }

    // 先扫一遍：会话级项目投票（编辑路径 / bash 命令 / 文本里出现的项目名）
    const votes = {};
    for (const ev of rows) {
      if (ev.type === "tool/call") {
        const name = ev.data && ev.data.name;
        const a = argsOf(ev);
        if (name === "edit" || name === "write") {
          const p = projectFromText(a.file_path || a.path || "");
          if (p) votes[p] = (votes[p] || 0) + 3;
        }
        if (name === "bash") {
          const p = projectFromText(a.command || "");
          if (p) votes[p] = (votes[p] || 0) + 2;
        }
      } else if (ev.type === "user/message") {
        const kind = ev.data && ev.data.source && ev.data.source.kind;
        if (kind !== "user") continue;
        const text = (ev.data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
        const p = projectFromText(text);
        if (p) votes[p] = (votes[p] || 0) + 1;
      }
    }
    const sessionProject = Object.entries(votes).sort((a, b) => b[1] - a[1]).map(([k]) => k)[0] || "";

    // 按 turn 聚合
    const turns = new Map();
    let cur = null;
    const newTurn = (n) => ({
      turn: n, seqStart: null, seqEnd: null, time: 0,
      users: [], assistants: [], errors: [], edits: [], decisions: [], memories: [],
      toolResults: 0, toolCalls: 0
    });

    for (const ev of rows) {
      if (!KEEP_EVENT.has(ev.type)) continue;
      const t = ev.time || 0;
      if (ev.type === "turn/start") {
        cur = newTurn(ev.data && ev.data.turn);
        cur.seqStart = ev.seq;
        if (t) cur.time = t;
        turns.set(cur.turn, cur);
        continue;
      }
      if (!cur) { cur = newTurn(0); cur.seqStart = ev.seq; turns.set(0, cur); }
      if (ev.type === "turn/end") {
        cur.seqEnd = ev.seq;
        cur = null;
        continue;
      }
      cur.seqEnd = ev.seq;
      if (!cur.time && t) cur.time = t;

      if (ev.type === "user/message") {
        const kind = ev.data && ev.data.source && ev.data.source.kind;
        if (kind !== "user") continue;
        const text = (ev.data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (text) cur.users.push({ text, seq: ev.seq });
      } else if (ev.type === "assistant/message") {
        const text = (ev.data.message && ev.data.message.content || [])
          .filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (text) cur.assistants.push({ text, seq: ev.seq });
      } else if (ev.type === "tool/call") {
        cur.toolCalls++;
        const name = ev.data && ev.data.name;
        const args = argsOf(ev);
        if (name === "edit" || name === "write") {
          cur.edits.push({
            tool: name, file: args.file_path || args.path || "",
            old: jsonSafe(args.old_string || args.content || args.new_string, 900),
            new: jsonSafe(args.new_string || args.content, 900),
            seq: ev.seq
          });
        }
        if (name === "memory_remember" || name === "memory_update") {
          cur.memories.push({ content: jsonSafe(args.content, 400), seq: ev.seq });
        }
        if (name === "ask_user_question") {
          cur.decisions.push({ kind: "ask", q: jsonSafe(args.questions, 500), seq: ev.seq, selected: null });
        }
      } else if (ev.type === "tool/result") {
        cur.toolResults++;
        const msg = ev.data && ev.data.message;
        const isError = !!(ev.data && ev.data.message && ev.data.message.isError);
        const err = ev.data && ev.data.error;
        if (isError) {
          const text = (msg && msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
          cur.errors.push({ code: (err && err.code) || "", name: (err && err.name) || "", text: truncate(text, 700), seq: ev.seq });
        } else if (cur.decisions.length) {
          const d = cur.decisions[cur.decisions.length - 1];
          if (d.kind === "ask" && d.selected == null) {
            const text = (msg && msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
            if (/"answers"/.test(text)) d.selected = truncate(text, 400);
          }
        }
      } else if (ev.type === "approval/decided") {
        cur.decisions.push({ kind: "approval", q: "", seq: ev.seq, selected: jsonSafe(ev.data, 200) });
      }
    }

    const turnMax = turns.size ? Math.max(...turns.keys()) : 0;
    for (const t of turns.values()) {
      if (!t.users.length && !t.errors.length && !t.edits.length) continue;
      const project = (t.edits.map((e) => projectFromText(e.file) || projectFromPath(e.file)).find(Boolean))
        || sessionProject || "工作区";
      const hasError = t.errors.length > 0;
      const recovered = hasError && t.toolResults > t.errors.length;
      const whyUser = t.users.find((u) => WHY_RE.test(u.text));
      if (opt.excludeSelf && project === "学习小助手") continue;
      const base = {
        sessionId: header.id || path.basename(path.dirname(file)),
        sessionFile: f.file,
        project,
        turn: t.turn,
        turnMax,
        time: t.time,
        timeText: fmtTime(t.time),
        seqStart: t.seqStart,
        seqEnd: t.seqEnd
      };

      // ── 机制 / 判断 候选
      if (hasError || whyUser || t.memories.length || t.decisions.some((d) => d.kind === "approval")) {
        const signals = [];
        let score = 0;
        if (hasError) { signals.push("tool-error"); score += 3; }
        if (recovered) { signals.push("recovered"); score += 2; }
        if (whyUser) { signals.push("user-why"); score += 2; }
        if (t.memories.length) { signals.push("ai-already-summarized"); score += 2; }
        if (t.decisions.some((d) => d.kind === "approval")) { signals.push("approval"); score += 2; }
        if (t.decisions.some((d) => d.kind === "ask" && d.selected)) { signals.push("decision"); score += 2; }
        if (whyUser && whyUser.text.length > 25) score += 1;
        if (score >= 2) {
          const allText = [...t.users.map((u) => u.text), ...t.assistants.map((a) => a.text)].join("\n");
          candidates.push({
            id: `cand-mech-${base.sessionId.slice(-8)}-t${t.turn}`,
            lane: /验|取舍|降级|测试|发布|方案/.test(t.users.map((u) => u.text).join("")) ? "judgment" : "mechanism",
            ...base,
            score,
            signals,
            userText: t.users.map((u) => ({ text: truncate(u.text, 700), seq: u.seq })),
            assistantText: t.assistants.slice(-3).map((a) => ({ text: truncate(a.text, 1200), seq: a.seq })),
            errors: t.errors.map((e) => ({ ...e, text: truncate(e.text, 500) })),
            decisions: t.decisions.map((d) => ({ kind: d.kind, q: d.q, selected: d.selected, seq: d.seq })),
            memories: t.memories
          });
          if (PERF_RE.test(allText)) {
            candidates.push({
              id: `cand-algo-${base.sessionId.slice(-8)}-t${t.turn}`,
              lane: "algorithm",
              ...base,
              score: score + 1,
              signals: [...signals, "perf-hint"],
              userText: t.users.map((u) => ({ text: truncate(u.text, 700), seq: u.seq })),
              assistantText: t.assistants.slice(-2).map((a) => ({ text: truncate(a.text, 1200), seq: a.seq })),
              errors: t.errors.map((e) => ({ ...e, text: truncate(e.text, 500) })),
              decisions: [],
              memories: []
            });
          }
        }
      }

      // ── 语法 候选：这一轮改了真实代码
      if (t.edits.length) {
        const codeEdits = t.edits.filter((e) => /\.(js|mjs|ts|tsx|jsx|py|css|html|json|sh|md)$/i.test(e.file));
        if (codeEdits.length) {
          candidates.push({
            id: `cand-syn-${base.sessionId.slice(-8)}-t${t.turn}`,
            lane: "syntax",
            ...base,
            score: 2 + Math.min(codeEdits.length, 4) + (whyUser ? 2 : 0),
            signals: ["code-edit", ...(whyUser ? ["user-why"] : [])],
            userText: t.users.map((u) => ({ text: truncate(u.text, 700), seq: u.seq })),
            assistantText: t.assistants.slice(-2).map((a) => ({ text: truncate(a.text, 900), seq: a.seq })),
            edits: codeEdits.slice(0, 6),
            errors: t.errors.map((e) => ({ ...e, text: truncate(e.text, 400) })),
            decisions: [],
            memories: []
          });
        }
      }
    }
    perFile.push({ file: path.basename(path.dirname(f.file)), events: rows.length, turns: turns.size });
  }

  candidates.sort((a, b) => b.score - a.score || (b.time || 0) - (a.time || 0));
  const kept = candidates.slice(0, opt.cap);
  return { files, candidates, kept, perFile, opt };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const result = await scanSessions(opt);
  const { files, candidates, kept, perFile } = result;
  ensureDir(path.dirname(opt.outFile));
  fs.writeFileSync(opt.outFile, JSON.stringify({
    generatedAt: Date.now(),
    scannedSessions: files.length,
    totalCandidates: candidates.length,
    kept: kept.length,
    perFile,
    candidates: kept
  }, null, 2));

  const byLane = {};
  for (const c of kept) byLane[c.lane] = (byLane[c.lane] || 0) + 1;
  console.log(`sessions scanned : ${files.length}`);
  console.log(`candidates       : ${candidates.length} (kept ${kept.length})`);
  console.log(`by lane          : ${JSON.stringify(byLane)}`);
  console.log(`written          : ${opt.outFile}`);

  const top = kept.slice(0, 12).map((c) => {
    const u = (c.userText && c.userText[0]) || {};
    const e = (c.edits && c.edits[0]) || {};
    return `${String(c.score).padStart(2)} ${c.lane.padEnd(9)} ${String(c.project).padEnd(18)} ${c.timeText} ${truncate(u.text || e.file || "", 46)}`;
  });
  console.log("\n-- top 12 --");
  for (const line of top) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
