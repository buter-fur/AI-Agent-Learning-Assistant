import { spawn } from "node:child_process";
import fs from "node:fs";
import { decompressAllFrames } from "./zstd.mjs";
import path from "node:path";
import os from "node:os";

/**
 * DSH 日志是"一帧 header + 每批一帧"的多帧 zstd 拼接。
 * 优先用纯 JS 逐帧解（跨平台、不用装 zstd）；解不了再退回系统命令。
 */
export function readJsonlSync(file) {
  try {
    const text = decompressAllFrames(fs.readFileSync(file)).buffer.toString("utf8");
    return Promise.resolve(parseJsonl(text));
  } catch {
    return readViaCli(file);
  }
}

function parseJsonl(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

function readViaCli(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn("zstd", ["-dc", "--", file], { maxBuffer: 1 << 30 });
    const chunks = [];
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`zstd exit ${code}: ${file}`));
      resolve(parseJsonl(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** Walk $DSH_HOME/sessions and return every session log file. */
export function listSessionFiles() {
  const root = path.join(dshHome(), "sessions");
  const found = [];
  if (!fs.existsSync(root)) return found;
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(root, ws.name);
    for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      const dir = path.join(wsDir, s.name);
      for (const f of fs.readdirSync(dir)) {
        if (/^session.*\.jsonl\.zstd$/.test(f)) {
          found.push({ file: path.join(dir, f), workspaceDir: ws.name, sessionDir: s.name });
        }
      }
    }
  }
  return found;
}

/** "--Users-…-default-workspace--" -> "/Users/…/default-workspace" (best effort). */
export function decodeWorkspaceDir(name) {
  let s = name;
  if (s.startsWith("--")) s = s.slice(2);
  if (s.endsWith("--")) s = s.slice(0, -2);
  s = s.replace(/~(?:[0-9A-F]{4})/gi, (m) => String.fromCharCode(parseInt(m.slice(1), 16)));
  return "/" + s.replace(/-/g, "/").replace(/^\/+/, "");
}

export function textOfEvent(ev) {
  if (!ev || !ev.data) return "";
  const d = ev.data;
  const parts = [];
  if (d.message && Array.isArray(d.message.content)) {
    for (const b of d.message.content) {
      if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
      if (b && b.type === "reasoning" && typeof b.text === "string") parts.push(b.text);
    }
  }
  if (Array.isArray(d.content)) {
    for (const b of d.content) {
      if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

export function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function projectFromPath(filePath) {
  if (!filePath) return "";
  const abs = path.resolve(filePath);
  const home = os.homedir();
  const ws = process.cwd();
  for (const base of [ws, home]) {
    const rel = path.relative(base, abs);
    if (rel && !rel.startsWith("..")) {
      const seg = rel.split(path.sep)[0];
      if (seg && !/^\./.test(seg) && seg !== "Documents") return seg;
    }
  }
  return "";
}
