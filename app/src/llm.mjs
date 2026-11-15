/**
 * llm — 极小的 OpenAI 兼容客户端（DeepSeek / OpenAI / 本地 mock 都能用）。
 * 配置优先级：环境变量 > config.json > 默认值。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_FILE = process.env.LEARN_CONFIG
  ? path.resolve(process.env.LEARN_CONFIG)
  : path.join(ROOT, "config.json");

export function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    /* 没有 config.json 就走默认值 */
  }
  const apiKey = String(
    process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || cfg.apiKey || ""
  ).trim();
  return {
    baseURL: (process.env.OPENAI_BASE_URL || cfg.baseURL || "https://api.deepseek.com").replace(/\/+$/, ""),
    model: process.env.OPENAI_MODEL || cfg.model || "deepseek-flash",
    apiKey,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || cfg.timeoutMs || 60000),
    retries: Number(cfg.retries ?? 2),
    jsonMode: cfg.jsonMode !== false,
    temperature: cfg.temperature != null ? Number(cfg.temperature) : 0.4,
    maxTokens: Number(cfg.maxTokens || 4096),
    thinking: cfg.thinking && typeof cfg.thinking === "object" ? cfg.thinking : null,
    file: CONFIG_FILE
  };
}

export function maskKey(key) {
  if (!key) return "(未填)";
  if (key.length <= 10) return key.slice(0, 2) + "…";
  return key.slice(0, 6) + "…" + key.slice(-4);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一次 chat completion，带超时与 429/5xx 重试。 */
export async function chat(messages, cfg = loadConfig(), opts = {}) {
  if (!cfg.apiKey) throw new Error("API key 未填：打开 config.json，把 apiKey 填上，或设置环境变量 OPENAI_API_KEY");
  const url = `${cfg.baseURL}/chat/completions`;
  const body = {
    model: cfg.model,
    messages,
    temperature: opts.temperature != null ? opts.temperature : cfg.temperature,
    max_tokens: opts.maxTokens || cfg.maxTokens || 4096
  };
  if (cfg.jsonMode && opts.json !== false) body.response_format = { type: "json_object" };
  if (cfg.thinking) body.thinking = cfg.thinking;

  let lastErr;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        // 有的推理模型不支持 response_format，去掉 json 模式再试一次
        if (res.status === 400 && body.response_format && !opts.__noJsonFallback) {
          clearTimeout(timer);
          const retryOpts = Object.assign({}, opts, { __noJsonFallback: true, json: false });
          const again = await chat(messages, cfg, retryOpts);
          return again;
        }
        const retriable = res.status === 429 || res.status >= 500;
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (retriable && attempt < cfg.retries) {
          await sleep(800 * Math.pow(2, attempt));
          continue;
        }
        throw lastErr;
      }
      const data = JSON.parse(text);
      const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const content = msg.content || "";
      const reasoning = msg.reasoning_content || "";
      if (!content && !reasoning) throw new Error("模型返回空内容");
      return { content, reasoning, usage: data.usage || null, model: data.model || cfg.model };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const aborted = e.name === "AbortError";
      if (!aborted && attempt < cfg.retries && /fetch failed|ECONN|ETIMEDOUT/i.test(String(e.message))) {
        await sleep(800 * Math.pow(2, attempt));
        continue;
      }
      throw aborted ? new Error(`请求超时（${cfg.timeoutMs}ms）`) : e;
    }
  }
  throw lastErr || new Error("未知错误");
}

/** 连通性自检：一条极小的请求，报告地址、模型、延迟。 */
export async function check(cfg = loadConfig()) {
  const t0 = Date.now();
  const res = await chat(
    [{ role: "user", content: "只回复两个字：可用" }],
    cfg,
    { json: false, maxTokens: 1024, temperature: 0 }
  );
  const reply = String(res.content).trim().slice(0, 40);
  return {
    ok: true,
    ms: Date.now() - t0,
    reply: reply || "（只回了思考，没给正文——推理模型把额度用在思考上了，连通正常）",
    reasoningOnly: !reply,
    model: res.model,
    baseURL: cfg.baseURL
  };
}

/** 模型偶尔会包 ```json，这里做一次宽松解析。 */
export function parseJsonLoose(text) {
  if (!text) throw new Error("空内容");
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}
