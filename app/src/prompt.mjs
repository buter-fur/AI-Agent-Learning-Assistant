/**
 * prompt — 制卡提示词。CLI 批量生成和历史旁听共用同一份契约，避免两套 schema 漂移。
 */

export const SCHEMA_HINT = `只输出 JSON，形如 {"cards":[Card...],"concepts":[Concept...],"edges":[Edge...]}。
Card 字段：id,lane(mechanism|syntax|algorithm|judgment),conceptId,level(L0..L4),title(≤18),
scene(≤80),question(≤40),options(2-3 个且必须含"我不知道"),answerIndex,answer(≤40),
metaphor(≤80),explain(≤140),terms([{term,plain}] ≤3),takeaway(≤50),
boundary?{q,options,answerIndex,explain},figure?{type,caption,alt,spec},
quiz([{kind:"recall|apply|contrast|trace",q,options,answerIndex,explain}] 1-3),
source{project,session,time,quotes:[{who,text}]},crossProject?[]。
Concept 字段：id,name,domain,problem,lane,desc(≤60),level(0..5)。
Edge 字段：from,to,kind(prereq|cause|contrast|same),reason(≤20)。
硬规矩：引文必须逐字来自素材；正文不许出现第二人称失败叙述；标题不许含项目名/端口号/函数名。
没有值得做成卡的素材就输出 {"cards":[]}，不要凑数。`;

export const SYSTEM = `你是「学习小助手」的卡片作者。读者是非科班的编程学习者：能读懂 AI 的意图，读不懂代码。
你的任务是把一次真实的开发片段，变成一张"读完就能用"的学习卡。
讲法固定三段：先用生活比喻，再给术语和定义，最后一句"以后看到 X 先想到 Y"。
不要教科书腔，不要罗列定义，不要写"你当时失败了 N 次"。宁可少产，不要凑数。`;

/** 把一个提炼包变成一次模型请求的 user 内容。 */
export function buildUser(packet) {
  return `下面是候选素材。按契约产出 0–2 张卡（宁可为 0）。\n\n${packet}\n\n${SCHEMA_HINT}`;
}
