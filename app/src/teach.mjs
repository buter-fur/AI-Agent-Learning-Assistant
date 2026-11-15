/**
 * teach — 按需生成"例子"：同一个概念，换角度 / 往上进阶。
 * 只在用户点按钮时调用，不预生成。
 */
import { chat, loadConfig, parseJsonLoose, maskKey } from "./llm.mjs";

const SYSTEM = `你是「学习小助手」的例子生成器。读者是非科班的编程学习者：能读懂 AI 的意图，读不懂代码。
你只做一件事：给一个已有概念，补一个短例子。不要复述定义，不要讲道理，只给场景。
输出 JSON：{"example":{"text":"...","level":0|1,"angle":"一句话说明这个角度"}}
硬规矩：text ≤ 90 个字；必须是他项目里可能遇到的场景；不许出现未解释的新术语；不许和已有例子重复角度。`;

function buildUser(card, kind, examples) {
  const intro = [
    `概念：${card.title}`,
    `讲明白：${card.explain}`,
    `所以句：${card.takeaway}`,
    card.terms && card.terms.length ? `术语：${card.terms.map((t) => t.term + "=" + t.plain).join("；")}` : "",
    examples.length ? "已有例子（不要重复这些角度）：\n" + examples.map((e, i) => `${i + 1}. [${e.level ? "进阶" : "普通"}] ${e.text}（角度：${e.angle}）`).join("\n") : "还没有例子。"
  ].filter(Boolean).join("\n");
  const ask = kind === "advanced"
    ? "请生成一个**更进阶**的例子（level=1）：在原来基础上加一个约束条件、或推到边界情况、或换到另一个项目的场景，让他感到“原来还有这一层”。"
    : "请生成一个**同层但换角度**的例子（level=0）：换一个他项目里可能遇到的场景，不要重复已有角度。";
  return `${intro}\n\n${ask}`;
}

export async function generateExample(card, kind) {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error("config.json 里还没填 apiKey");
  const examples = card.examples || [];
  const res = await chat([
    { role: "system", content: SYSTEM },
    { role: "user", content: buildUser(card, kind, examples) }
  ], cfg, { maxTokens: 900, temperature: 0.7 });
  const json = parseJsonLoose(res.content);
  const ex = json.example || json;
  if (!ex || !ex.text) throw new Error("模型没给出例子");
  return {
    text: String(ex.text).slice(0, 120),
    level: Number(ex.level) || (kind === "advanced" ? 1 : 0),
    angle: String(ex.angle || "").slice(0, 40),
    at: Date.now(),
    by: cfg.model
  };
}

const SCENARIO_SYSTEM = `你是「学习小助手」的例子生成器。给一个工作流场景，补一个用户自己项目里可能发生的真实例子。
输出 JSON：{"example":{"text":"...","angle":"一句话说明这个场景的关键动作"}}
text ≤ 100 字，必须具体到“他改了什么、结果怎样、下一步该做什么”，不要讲道理。`;

export async function generateScenarioExample(card, scenario) {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error("config.json 里还没填 apiKey");
  const wf = card.workflow || {};
  const res = await chat([
    { role: "system", content: SCENARIO_SYSTEM },
    { role: "user", content: `工作流：${card.title}\n步骤：${(wf.steps || []).map((s) => s.name).join(" → ")}\n场景：${scenario.name}（${scenario.desc}）\n\n请给一个这个场景下的真实例子。` }
  ], cfg, { maxTokens: 800, temperature: 0.7 });
  const json = parseJsonLoose(res.content);
  const ex = json.example || json;
  if (!ex || !ex.text) throw new Error("模型没给出例子");
  return { text: String(ex.text).slice(0, 140), angle: String(ex.angle || "").slice(0, 40), at: Date.now(), by: cfg.model };
}
