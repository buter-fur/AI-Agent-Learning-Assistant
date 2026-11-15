#!/usr/bin/env node
/**
 * generate — 用 OpenAI 兼容接口把 packets 批量变成卡片。
 *
 *   node src/generate.mjs --check            # 只测连通性（不花多少 token）
 *   node src/generate.mjs --dry-run          # 导出第一条 prompt，不调接口
 *   node src/generate.mjs --limit 3          # 只跑前 3 个提炼包
 *   node src/generate.mjs --packet cand-syn-xxxx-t3
 *
 * key 填在 config.json 的 apiKey 字段（或环境变量 OPENAI_API_KEY）。
 * 产出：data/out/api-<时间戳>/batch.json —— 再跑 node src/ingest.mjs 校验入库。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "./util.mjs";
import { loadConfig, chat, check, parseJsonLoose, maskKey } from "./llm.mjs";
import { SYSTEM, buildUser } from "./prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKETS = path.join(ROOT, "data", "packets");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);
const num = (name, d) => {
  const v = arg(name);
  return v == null ? d : Number(v);
};

async function runOne(file, cfg) {
  const packet = fs.readFileSync(path.join(PACKETS, file), "utf8");
  const res = await chat(
    [{ role: "system", content: SYSTEM }, { role: "user", content: buildUser(packet) }],
    cfg
  );
  if (!String(res.content).trim()) {
    throw new Error("模型只输出了思考、没有正文（推理模型把 max_tokens 用完了）——把 config.json 的 maxTokens 调大，或换非推理模型");
  }
  const json = parseJsonLoose(res.content);
  return {
    cards: json.cards || [],
    concepts: json.concepts || [],
    edges: json.edges || [],
    usage: res.usage
  };
}

async function main() {
  const cfg = loadConfig();

  if (has("--check")) {
    console.log(`配置：${cfg.file}`);
    console.log(`地址：${cfg.baseURL}`);
    console.log(`模型：${cfg.model}`);
    console.log(`密钥：${maskKey(cfg.apiKey)}`);
    if (!cfg.apiKey) {
      console.log("\n还没有 key。打开 config.json，把 apiKey 填上（第 4 行），再跑一次。");
      process.exit(2);
    }
    console.log("正在请求…");
    const r = await check(cfg);
    console.log(`\n✅ 可用：${r.ms} ms，模型 ${r.model}，回复「${r.reply}」`);
    if (r.reasoningOnly) console.log("   （提示：这是推理模型，生成卡片时额度会给足，不用改）");
    return;
  }

  if (!fs.existsSync(PACKETS)) {
    console.error("先跑 node src/packet.mjs");
    process.exit(1);
  }
  const only = arg("--packet");
  let files = fs.readdirSync(PACKETS).filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort();
  if (only) files = files.filter((f) => f.includes(only));
  const limit = num("--limit", files.length);
  files = files.slice(0, limit);
  if (!files.length) {
    console.error("没有匹配的提炼包。先跑 node src/packet.mjs，或用 --packet 指定 id 片段。");
    process.exit(1);
  }

  if (has("--dry-run")) {
    const out = path.join(PACKETS, "_dryrun.md");
    fs.writeFileSync(out, `## SYSTEM\n${SYSTEM}\n\n## USER\n${buildUser(fs.readFileSync(path.join(PACKETS, files[0]), "utf8"))}`);
    console.log(`dry-run prompt -> ${out}（将跑 ${files.length} 个包）`);
    return;
  }

  if (!cfg.apiKey) {
    console.error("缺 API key。两个办法：");
    console.error("  1) 打开 config.json，填 apiKey（推荐，填完跑 node src/generate.mjs --check）");
    console.error("  2) 设置环境变量 OPENAI_API_KEY，或者用 agent 模式手工写 data/out/*.json");
    process.exit(2);
  }

  const outDir = ensureDir(path.join(ROOT, "data", "out", `api-${Date.now()}`));
  const all = { version: 1, cards: [], concepts: [], edges: [] };
  const usage = { prompt: 0, completion: 0, total: 0 };
  let ok = 0;
  let fail = 0;
  const conc = Math.max(1, Math.min(4, num("--concurrency", 2)));

  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const file = files[cursor++];
      const t0 = Date.now();
      try {
        const r = await runOne(file, cfg);
        all.cards.push(...r.cards);
        all.concepts.push(...r.concepts);
        all.edges.push(...r.edges);
        if (r.usage) {
          usage.prompt += r.usage.prompt_tokens || 0;
          usage.completion += r.usage.completion_tokens || 0;
          usage.total += r.usage.total_tokens || 0;
        }
        ok++;
        console.log(`ok   ${file}  +${r.cards.length} 张  ${Date.now() - t0}ms`);
      } catch (e) {
        fail++;
        console.log(`fail ${file}  ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));

  fs.writeFileSync(path.join(outDir, "batch.json"), JSON.stringify(all, null, 2));
  console.log(`\n完成：${ok} 成功 / ${fail} 失败`);
  console.log(`卡片 ${all.cards.length} 张，概念 ${all.concepts.length} 个，边 ${all.edges.length} 条`);
  if (usage.total) console.log(`tokens：输入 ${usage.prompt} / 输出 ${usage.completion} / 合计 ${usage.total}`);
  console.log(`产物：${path.relative(ROOT, path.join(outDir, "batch.json"))}`);
  console.log(`下一步：node src/ingest.mjs --in ${path.relative(ROOT, outDir)}`);
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
