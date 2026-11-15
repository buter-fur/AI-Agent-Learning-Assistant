/**
 * kb — 本地知识库客户端（HTTP）。失败一律软降级，不阻塞实时链路。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULTS = {
  enabled: true,
  baseURL: "http://127.0.0.1:8790",
  timeoutMs: 800,
  popThreshold: 0.6,
  gateThreshold: 0.35
};

function cfg() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    return { ...DEFAULTS, ...(raw.kb || {}) };
  } catch {
    return DEFAULTS;
  }
}

let fails = 0;
let disabledUntil = 0;

async function call(pathname, body, timeoutMs) {
  const c = cfg();
  if (!c.enabled) return null;
  if (Date.now() < disabledUntil) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(c.baseURL + pathname, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error("http " + res.status);
    const data = await res.json();
    fails = 0;
    return data;
  } catch {
    fails += 1;
    if (fails >= 3) disabledUntil = Date.now() + 60_000;
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function search(query, k = 5) {
  const c = cfg();
  const data = await call("/search", { query, k }, c.timeoutMs);
  return (data && data.items) || [];
}

export async function item(id) {
  const c = cfg();
  const data = await call("/item/" + encodeURIComponent(id), null, 3000);
  return data && data.ok ? data : null;
}

export async function health() {
  return call("/health", null, 1000);
}

export function thresholds() {
  const c = cfg();
  return { pop: c.popThreshold, gate: c.gateThreshold };
}
