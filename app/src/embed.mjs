/**
 * embed — 远程 embedding 提供商接口（可选增强）。
 *
 * 设计原则：
 *   - 默认关闭，不联网、不花钱也能用（语义地图回退到本地字面相似度）。
 *   - 只约定一种协议：OpenAI 兼容的 POST {baseURL}/embeddings。
 *     OpenAI / SiliconFlow / 阿里百炼兼容模式 / 自建网关都符合，换成别家只是填不同 baseURL + model。
 *   - 必须显式填 API Key 才会发请求；key 只存在本地 config.json，接口只回脱敏值。
 *   - 向量按 sha256(model + 文本) 落盘缓存，重复重建不再花钱；缓存有上限，超出丢最旧的。
 *   - 失败一律抛错，由调用方回退本地算法，并在产物里写明原因（不假装是语义结果）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, maskKey } from "./llm.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_FILE = path.join(ROOT, "data", "embeddings.json");
const CACHE_MAX = 4000;

/** 预设只是省去填 baseURL/model；协议都是 OpenAI 兼容。 */
export const EMBEDDING_PROVIDERS = [
  {
    id: "openai-compatible",
    label: "OpenAI 兼容 /v1/embeddings",
    baseURL: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    hint: "任何兼容 OpenAI embeddings 协议的服务都能接"
  },
  {
    id: "siliconflow",
    label: "SiliconFlow（OpenAI 兼容）",
    baseURL: "https://api.siliconflow.cn/v1",
    model: "BAAI/bge-m3",
    hint: "国内直连、按量计费；模型名可换成任意在售 embedding 模型"
  },
  {
    id: "dashscope",
    label: "阿里百炼（兼容模式）",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "text-embedding-v3",
    hint: "DashScope 兼容模式；需要该平台的 API Key"
  },
  {
    id: "custom",
    label: "自建 / 其他兼容网关",
    baseURL: "",
    model: "",
    hint: "自己填 baseURL 和 model；协议仍是 {baseURL}/embeddings"
  }
];

const DEFAULTS = {
  enabled: false,
  provider: "openai-compatible",
  baseURL: "",
  model: "",
  apiKey: "",
  dim: 0,              // 0 = 由服务端决定；填了只用来校验
  timeoutMs: 10000,
  batchSize: 64,
  maxChars: 1800,
  maxEntries: 300,     // 条目太多时不做远程 embedding（费用/延迟闸门）
  useForSearch: false  // 实时检索是否也用 embedding（每次查询多一次小请求）
};

export function providerDefaults(providerId) {
  return EMBEDDING_PROVIDERS.find((p) => p.id === providerId) || EMBEDDING_PROVIDERS[0];
}

function readRawConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

/** 环境变量 > config.json > 默认值。 */
export function loadEmbeddingConfig() {
  const raw = readRawConfig();
  const e = (raw.embedding && typeof raw.embedding === "object") ? raw.embedding : {};
  const preset = providerDefaults(e.provider || DEFAULTS.provider);
  const baseURL = String(
    process.env.EMBEDDING_BASE_URL || e.baseURL || preset.baseURL || ""
  ).trim().replace(/\/+$/, "");
  const model = String(process.env.EMBEDDING_MODEL || e.model || preset.model || "").trim();
  const apiKey = String(
    process.env.EMBEDDING_API_KEY || process.env.OPENAI_EMBEDDING_API_KEY || e.apiKey || ""
  ).trim();
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    enabled: e.enabled === true,
    provider: String(e.provider || DEFAULTS.provider),
    baseURL,
    model,
    apiKey,
    dim: Math.max(0, Math.min(4096, num(e.dim, DEFAULTS.dim))),
    timeoutMs: Math.max(1500, Math.min(60000, num(e.timeoutMs, DEFAULTS.timeoutMs))),
    batchSize: Math.max(1, Math.min(128, num(e.batchSize, DEFAULTS.batchSize))),
    maxChars: Math.max(200, Math.min(8000, num(e.maxChars, DEFAULTS.maxChars))),
    maxEntries: Math.max(1, Math.min(5000, num(e.maxEntries, DEFAULTS.maxEntries))),
    useForSearch: e.useForSearch === true,
    file: CONFIG_FILE
  };
}

export function embeddingConfigured(cfg = loadEmbeddingConfig()) {
  return !!(cfg.enabled && cfg.baseURL && cfg.model && cfg.apiKey);
}

function cacheShape() {
  return { version: 1, model: "", baseURL: "", vectors: {}, updatedAt: 0 };
}

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!raw || raw.version !== 1 || typeof raw.vectors !== "object") return cacheShape();
    return raw;
  } catch {
    return cacheShape();
  }
}

function saveCache(cache) {
  cache.updatedAt = Date.now();
  const keys = Object.keys(cache.vectors);
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => (cache.vectors[a].ts || 0) - (cache.vectors[b].ts || 0));
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache.vectors[k];
  }
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = CACHE_FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE_FILE);
  } catch { /* 缓存写失败不影响本次结果 */ }
}

function textHash(model, text) {
  return crypto.createHash("sha256").update(model).update("\u0000").update(text).digest("hex").slice(0, 40);
}

/** 对外：脱敏后的配置 + 上次语义地图用的是哪种模式 + 缓存条数。 */
export function publicEmbeddingConfig() {
  const cfg = loadEmbeddingConfig();
  const cache = loadCache();
  let lastMode = null;
  try {
    const map = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "kb-map.json"), "utf8"));
    lastMode = map.embedding || null;
  } catch { /* 还没生成过地图 */ }
  return {
    ok: true,
    enabled: cfg.enabled,
    configured: embeddingConfigured(cfg),
    provider: cfg.provider,
    providers: EMBEDDING_PROVIDERS,
    baseURL: cfg.baseURL,
    model: cfg.model,
    hasKey: !!cfg.apiKey,
    maskedKey: cfg.apiKey ? maskKey(cfg.apiKey) : "",
    dim: cfg.dim,
    batchSize: cfg.batchSize,
    maxEntries: cfg.maxEntries,
    timeoutMs: cfg.timeoutMs,
    useForSearch: cfg.useForSearch,
    cacheCount: Object.keys(cache.vectors).length,
    cacheModel: cache.model || "",
    lastMode
  };
}

async function requestBatch(cfg, inputs) {
  const url = cfg.baseURL + "/embeddings";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({ model: cfg.model, input: inputs, encoding_format: "float" }),
      signal: ctrl.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    const list = Array.isArray(data.data) ? data.data : (Array.isArray(data.embeddings) ? data.embeddings : null);
    if (!list || !list.length) throw new Error("embedding 响应里没有向量（期望 data[].embedding）");
    const rows = list.map((row, i) => ({
      index: Number.isFinite(row.index) ? row.index : i,
      vector: Array.isArray(row.embedding) ? row.embedding : row
    }));
    rows.sort((a, b) => a.index - b.index);
    const vectors = rows.map((r) => r.vector);
    if (vectors.length !== inputs.length) throw new Error(`embedding 返回 ${vectors.length} 条，请求 ${inputs.length} 条`);
    for (const v of vectors) {
      if (!Array.isArray(v) || !v.length) throw new Error("embedding 返回了空向量");
      if (cfg.dim && v.length !== cfg.dim) throw new Error(`向量维度 ${v.length} 与配置 dim=${cfg.dim} 不一致`);
    }
    return { vectors, model: data.model || cfg.model };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error(`请求超时（${cfg.timeoutMs}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 批量取向量（带缓存）。返回 {vectors, dim, model, provider, apiCalls, cached}。
 * 任何网络/协议错误都会抛出，由调用方回退。
 */
export async function embedTexts(texts, cfg = loadEmbeddingConfig()) {
  if (!embeddingConfigured(cfg)) throw new Error("远程 embedding 未配置（enabled/baseURL/model/apiKey 缺一不可）");
  const inputs = (texts || []).map((t) => String(t || "").slice(0, cfg.maxChars));
  if (!inputs.length) return { vectors: [], dim: 0, model: cfg.model, provider: cfg.provider, apiCalls: 0, cached: 0 };

  const cache = loadCache();
  if (cache.model !== cfg.model || cache.baseURL !== cfg.baseURL) {
    cache.model = cfg.model;
    cache.baseURL = cfg.baseURL;
    cache.vectors = {};
  }
  const vectors = new Array(inputs.length);
  const missing = [];
  for (let i = 0; i < inputs.length; i++) {
    const key = textHash(cfg.model, inputs[i]);
    const hit = cache.vectors[key];
    if (hit && Array.isArray(hit.v) && hit.v.length) vectors[i] = hit.v;
    else missing.push({ i, key, text: inputs[i] });
  }

  let apiCalls = 0;
  let dim = 0;
  for (let start = 0; start < missing.length; start += cfg.batchSize) {
    const batch = missing.slice(start, start + cfg.batchSize);
    const r = await requestBatch(cfg, batch.map((b) => b.text));
    apiCalls += 1;
    if (!dim) dim = r.vectors[0].length;
    if (cfg.dim && r.vectors[0].length !== cfg.dim) throw new Error(`向量维度与配置 dim=${cfg.dim} 不一致`);
    for (let j = 0; j < batch.length; j++) {
      vectors[batch[j].i] = r.vectors[j];
      cache.vectors[batch[j].key] = { v: r.vectors[j], ts: Date.now() };
    }
    saveCache(cache);
  }

  if (!dim) dim = vectors.find(Boolean) ? vectors.find(Boolean).length : 0;
  const cacheCount = Object.keys(loadCache().vectors).length;
  return {
    vectors, dim, model: cfg.model, provider: cfg.provider,
    apiCalls, cached: inputs.length - missing.length, cacheCount
  };
}

/** 只取本地缓存里的向量，不发请求（给检索兜底用）。 */
export function cachedEmbedding(text, cfg = loadEmbeddingConfig()) {
  if (!cfg.model) return null;
  const cache = loadCache();
  if (cache.model !== cfg.model) return null;
  const hit = cache.vectors[textHash(cfg.model, String(text || "").slice(0, cfg.maxChars))];
  return hit && Array.isArray(hit.v) ? hit.v : null;
}

export function cacheStats() {
  const cache = loadCache();
  return { count: Object.keys(cache.vectors).length, model: cache.model || "", baseURL: cache.baseURL || "", updatedAt: cache.updatedAt || 0 };
}

/** 连通性自检：一次最小请求，报告延迟/维度/模型。 */
export async function testEmbedding(overrides = {}) {
  const base = loadEmbeddingConfig();
  const merged = { ...base };
  for (const key of ["enabled", "provider", "baseURL", "model", "apiKey", "dim", "timeoutMs", "batchSize", "maxChars"]) {
    if (overrides[key] === undefined || overrides[key] === null || overrides[key] === "") continue;
    if (key === "apiKey" && String(overrides[key]).trim() === "") continue;
    merged[key] = overrides[key];
  }
  if (overrides.apiKey && String(overrides.apiKey).trim()) merged.apiKey = String(overrides.apiKey).trim();
  merged.baseURL = String(merged.baseURL || "").replace(/\/+$/, "");
  merged.enabled = true;
  if (!merged.baseURL) return { ok: false, error: "还没填 API 地址" };
  if (!merged.model) return { ok: false, error: "还没填模型名" };
  if (!merged.apiKey) return { ok: false, error: "还没填 embedding API Key" };
  const t0 = Date.now();
  try {
    const r = await requestBatch(merged, ["学习小助手 embedding 连通性测试"]);
    return {
      ok: true, ms: Date.now() - t0, dim: r.vectors[0].length,
      model: r.model || merged.model, provider: merged.provider,
      sample: r.vectors[0].slice(0, 4).map((x) => Number(x.toFixed(4)))
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e && e.message || e) };
  }
}
