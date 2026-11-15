/**
 * where — 「回到现场」：给定 source 里的 session + seq 锚点，从 DSH 会话日志里
 * 取回锚点前后几条真实消息，在卡片站里直接看，不用离开页面。
 *
 * 为什么不是深链：DSH 目前只有 `dsh-session:` 会话引用（用于在新会话里 @ 引用），
 * 没有“按 seq 定位到某条消息”的深链；所以这里做的是把现场原文取回来。
 */
import path from "node:path";
import { listSessionFiles, readJsonlSync } from "./util.mjs";

function messageText(ev) {
  const d = ev.data || {};
  if (ev.type === "assistant/message") {
    const m = d.message || {};
    const blocks = Array.isArray(m.content) ? m.content : [];
    return blocks.filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text).join("\n").trim();
  }
  if (ev.type === "user/message") {
    const blocks = Array.isArray(d.content) ? d.content : [];
    return blocks.filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text).join("\n").trim();
  }
  return "";
}

/**
 * @param {{session?:string, seq?:number|string, quote?:string, before?:number, after?:number}} q
 */
export async function locate(q) {
  const want = String(q.session || "").replace(/^session-/, "").trim();
  if (!want) return { ok: false, error: "来源里没有会话 id" };
  const files = listSessionFiles().filter((f) => f.sessionDir.includes(want));
  if (!files.length) return { ok: false, error: "找不到这个会话的日志（可能已被清理）" };
  files.sort((a, b) => b.sessionDir.length - a.sessionDir.length);
  const target = files[0];

  let rows;
  try {
    rows = await readJsonlSync(target.file);
  } catch (e) {
    return { ok: false, error: "日志解压失败：" + String(e.message || e) };
  }

  const seq0 = Number(String(q.seq || "").split(",")[0]) || 0;
  const messages = [];
  for (const ev of rows) {
    if (ev.type !== "user/message" && ev.type !== "assistant/message") continue;
    const text = messageText(ev);
    if (!text) continue;
    const src = (ev.data && ev.data.source) || {};
    if (ev.type === "user/message" && src.kind && src.kind !== "user") continue; // 跳过工具/系统注入
    messages.push({
      seq: ev.seq,
      role: ev.type === "user/message" ? "user" : "assistant",
      turn: (ev.data && ev.data.turn) || 0,
      time: ev.time || 0,
      text
    });
  }
  if (!messages.length) return { ok: false, error: "这个会话里没有可读的对话消息" };

  const quote = String(q.quote || "").replace(/\s+/g, " ").trim();
  // 没有 seq 时：有引文就按引文找到那一句；连引文都没有，就从最后几条看起
  let idx;
  if (!seq0) {
    idx = quote ? messages.findIndex((m) => m.text.replace(/\s+/g, " ").includes(quote)) : -1;
    if (idx < 0) idx = quote ? -1 : messages.length - 1;
    if (idx < 0) idx = messages.length - 1;
  } else {
    idx = messages.findIndex((m) => m.seq >= seq0);
    if (idx < 0) idx = messages.length - 1;
  }
  const before = Math.max(0, Math.min(4, Number(q.before) || 2));
  const after = Math.max(1, Math.min(8, Number(q.after) || 5));
  const start = Math.max(0, idx - before);
  const slice = messages.slice(start, start + before + after);

  let quoteFound = false;
  const list = slice.map((m) => {
    const flat = m.text.replace(/\s+/g, " ");
    const hit = quote && flat.includes(quote);
    if (hit) quoteFound = true;
    return {
      seq: m.seq, role: m.role, turn: m.turn, time: m.time,
      text: m.text.length > 1600 ? m.text.slice(0, 1600) + "…" : m.text,
      hit: !!hit
    };
  });

  return {
    ok: true,
    session: path.basename(target.sessionDir),
    file: path.basename(target.file),
    seq: seq0,
    anchored: !!seq0,
    quoteFound: !!quoteFound,
    messages: list
  };
}
