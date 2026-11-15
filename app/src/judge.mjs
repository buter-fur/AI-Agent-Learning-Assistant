/**
 * judge — 灰区判定：知识库检索落在 0.35–0.60 时，用本地 27B 再判一次
 * 「这条知识到底能不能回答现场信号」。
 *
 * 它只在卡片没命中、知识库又只给了灰区命中时被调用；正常路径完全不走模型。
 * 本地模型没起 / 超时 → 用云端小判定兜底；两者都不可用才返回 null，调用方保持静默。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, chat } from "./llm.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULTS = {
  enabled: true,
  baseURL: "http://127.0.0.1:11434",
  model: "qwen3.8:27b-q5_K_M",
  timeoutMs: 20000,
  numCtx: 4096,
  numPredict: 96
};

export function judgeConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
    return { ...DEFAULTS, ...(raw.localJudge || {}) };
  } catch {
    return DEFAULTS;
  }
}

const cache = new Map(); // key -> { at, value }
const TTL = 10 * 60 * 1000;

function truncate(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function parseLoose(text) {
  let s = String(text || "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/**
 * @param {{text:string, item:{id?:string,title?:string,summary?:string,text?:string}}} input
 * @returns {Promise<{match:boolean, reason:string, ms:number}|null>}
 */
async function localReady(c) {
  if (!c.enabled) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 450);
  try {
    const res = await fetch(c.baseURL.replace(/\/+$/, "") + "/api/tags", { signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    const names = (data.models || []).map((m) => m.name);
    return res.ok && names.includes(c.model);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function judgeCloud(text, item, started) {
  const cfg = loadConfig();
  if (!cfg.apiKey) return null;
  try {
    const res = await chat(
      [
        {
          role: "system",
          content: [
            "你是学习助手的匹配判定器。",
            "任务：判断「候选知识」能不能直接回答「现场信号」。",
            "标准：能点破现场在问什么，或能解释现场卡住的原因，算 match；只是词面沾边、话题相近但答非所问，算 false。",
            "只输出 JSON：{\"match\":true 或 false,\"reason\":\"不超过 16 个字，说依据\"}"
          ].join("\n")
        },
        {
          role: "user",
          content: [
            "现场信号：" + truncate(text, 700),
            "候选知识：" + (item.title || "") + " / " + (item.summary || ""),
            truncate(item.text || item.preview || "", 700)
          ].join("\n")
        }
      ],
      { ...cfg, maxTokens: 128, temperature: 0, retries: 0, timeoutMs: 8000, thinking: /deepseek/i.test(cfg.baseURL || "") ? { type: "disabled" } : cfg.thinking },
      { json: true, maxTokens: 128, temperature: 0 }
    );
    const parsed = parseLoose(res.content);
    return {
      match: parsed.match === true,
      reason: truncate(parsed.reason || "", 40),
      ms: Date.now() - started,
      via: "cloud"
    };
  } catch {
    return null;
  }
}

export async function judgeGray({ text, item }) {
  const c = judgeConfig();
  const key = [c.model, item && item.id, truncate(text, 300)].join("|");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  // 没有本地模型/本地没时就跳过 20 秒 Ollama 超时，直接用云端做小判定。
  if (!(await localReady(c))) {
    const cloud = await judgeCloud(text, item, Date.now());
    if (cloud) {
      cache.set(key, { at: Date.now(), value: cloud });
      if (cache.size > 80) cache.delete(cache.keys().next().value);
    }
    return cloud;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(c.timeoutMs) || 20000);
  const started = Date.now();
  try {
    const body = {
      model: c.model,
      stream: false,
      think: false,
      format: "json",
      messages: [
        {
          role: "system",
          content: [
            "你是学习助手的匹配判定器。",
            "任务：判断「候选知识」能不能直接回答「现场信号」。",
            "标准：能点破现场在问什么，或能解释现场卡住的原因，算 match；只是词面沾边、话题相近但答非所问，算 false。",
            "只输出 JSON：{\"match\":true 或 false,\"reason\":\"不超过 16 个字，说依据\"}"
          ].join("\n")
        },
        {
          role: "user",
          content: [
            "现场信号：" + truncate(text, 700),
            "候选知识：" + (item.title || "") + " / " + (item.summary || ""),
            truncate(item.text || item.preview || "", 700)
          ].join("\n")
        }
      ],
      options: { temperature: 0, num_ctx: Number(c.numCtx) || 4096, num_predict: Number(c.numPredict) || 96 }
    };
    const res = await fetch(c.baseURL.replace(/\/+$/, "") + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = (data.message && data.message.content) || "";
    const parsed = parseLoose(raw);
    const value = {
      match: parsed.match === true,
      reason: truncate(parsed.reason || "", 40),
      ms: Date.now() - started
    };
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 80) cache.delete(cache.keys().next().value);
    return value;
  } catch {
    // 本地超时/失败时再用云端小判定兜底；云端也不可用才保持静默。
    const cloud = await judgeCloud(text, item, started);
    if (cloud) cache.set(key, { at: Date.now(), value: cloud });
    return cloud;
  } finally {
    clearTimeout(timer);
  }
}

/** 给 /api/health 用：探一下本地模型在不在（500ms 内）。 */
export async function judgeHealth() {
  const c = judgeConfig();
  if (!c.enabled) return { enabled: false, up: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 500);
  try {
    const res = await fetch(c.baseURL.replace(/\/+$/, "") + "/api/tags", { signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    const names = (data.models || []).map((m) => m.name);
    return { enabled: true, up: res.ok, model: c.model, modelPresent: names.includes(c.model) };
  } catch {
    return { enabled: true, up: false, model: c.model, modelPresent: false };
  } finally {
    clearTimeout(timer);
  }
}
