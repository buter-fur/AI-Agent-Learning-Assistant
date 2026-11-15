#!/usr/bin/env node
/**
 * watch — 实时嗅探：tail 一个正在写的 DSH 会话日志，把「卡住 / 追问」信号
 * 喂给本地服务的 /api/whisper/detect，由 value 决定弹 / 角标 / 不弹。
 *
 *   node src/watch.mjs                 # 盯最新会话，从当前位置开始
 *   node src/watch.mjs --replay        # 从头回放（演示用）
 *   node src/watch.mjs --session 4ccf89a0 --replay --once
 *   node src/watch.mjs --server http://127.0.0.1:4795
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decompressPrefix } from "./zstd.mjs";
import { listSessionFiles, textOfEvent } from "./util.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

const SERVER = arg("--server", "http://127.0.0.1:4780");
const INTERVAL = Number(arg("--interval", 1500));

function pickFile() {
  const want = arg("--session", "");
  const files = listSessionFiles().filter((f) => !want || f.sessionDir.includes(want));
  if (!files.length) { console.error("找不到会话文件"); process.exit(1); }
  files.sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);
  return files[0];
}

async function detect(signal) {
  try {
    const res = await fetch(`${SERVER}/api/whisper/detect`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(signal)
    });
    const d = await res.json();
    const tag = d.tier === "pop" ? "🔔 弹" : d.tier === "badge" ? "• 角标" : "· 不弹";
    console.log(`${tag}  [${signal.kind}] ${String(signal.text).slice(0, 46).replace(/\s+/g, " ")}`);
    if (d.reason) console.log(`      ${d.reason}`);
    return d;
  } catch (e) {
    console.error(`   (服务没起来？${SERVER}) ${e.message}`);
    return null;
  }
}

function handleEvent(ev, state, file, sessionId) {
  if (ev.type === "turn/start") { state.turn = ev.data && ev.data.turn; state.fired = {}; return; }
  if (ev.type === "tool/result") {
    const bad = ev.data && ev.data.message && ev.data.message.isError;
    const code = (ev.data && ev.data.error && ev.data.error.code) || "";
    const raw = ((ev.data && ev.data.message && ev.data.message.content) || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    // 工具层的操作性报错不是学习素材（编辑冲突、沙箱拒绝、被打断）
    const operational = /^FS_/.test(code) || /cannot (edit|modify)|old_string was not found|file has been modified|sandbox|aborted|must differ|no changes/i.test(raw + " " + code);
    if (bad && !operational && !state.fired.error) {
      state.fired.error = true;
      const text = (ev.data.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      detect({ sessionId, kind: "error", text: text || (ev.data.error && ev.data.error.code) || "error", file, turn: state.turn, seq: ev.seq });
    }
    return;
  }
  if (ev.type === "user/message") {
    const kind = ev.data && ev.data.source && ev.data.source.kind;
    if (kind !== "user") return;
    const text = (ev.data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (/为什么|为啥|怎么回事|不对|不是吧|看不懂|没看懂|怎么搞|有没有搞错/.test(text) && !state.fired.why) {
      state.fired.why = true;
      detect({ sessionId, kind: "why", text, file, turn: state.turn, seq: ev.seq });
    }
  }
}

async function main() {
  const target = pickFile();
  const sessionId = target.sessionDir.replace(/^session-/, "");
  console.log(`盯着：${path.basename(target.sessionDir)}  (${path.basename(target.file)})`);
  console.log(`服务：${SERVER}   间隔：${INTERVAL}ms\n`);

  let offset = 0;
  if (!has("--replay")) offset = fs.statSync(target.file).size;
  const state = { turn: 0, fired: {} };
  let buffer = "";
  const once = has("--once");

  const step = async () => {
    let size = 0;
    try { size = fs.statSync(target.file).size; } catch { return false; }
    if (size <= offset) return false;
    const fd = fs.openSync(target.file, "r");
    const len = size - offset;
    const chunk = Buffer.alloc(len);
    fs.readSync(fd, chunk, 0, len, offset);
    fs.closeSync(fd);

    const { buffer: plain, consumed, frames } = decompressPrefix(chunk);
    if (!consumed) return false;                       // 最后一帧还没写完整
    offset += consumed;
    buffer += plain.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop();                              // 留半行
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      handleEvent(ev, state, target.file, sessionId);
    }
    return frames > 0;
  };

  await step();
  if (once) return;
  setInterval(step, INTERVAL);
}

main();
