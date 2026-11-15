# v1 数据契约（前端 / 卡片工厂 / 服务端 共用）

> 这份文件是唯一的接口真相。前端只吃 `/api/bundle`，卡片工厂只写 `data/out/*.json`，服务端只做校验与聚合。
> 任何一方想改字段，先改这里。

---

## 1. 卡片 Card

```jsonc
{
  "id": "card-example-project-token-budget",   // 全局唯一，稳定，可读
  "lane": "mechanism",                          // mechanism | syntax | algorithm | judgment
  "conceptId": "token-budget",                  // 指向 concepts[].id，必须存在
  "level": "L2",                                // L0..L4，指这张卡的讲法深度
  "title": "模型只交了草稿，正文是空的",          // ≤18 字，判断句或问句
  "scene": "点「AI 润色」，弹窗报「接口未返回文本内容」，详情里却躺着一大段思考过程。", // ≤80 字
  "question": "你觉得是哪里出了问题？",           // ≤40 字
  "options": ["提示词写坏了", "输出额度被思考吃光了", "我不知道"], // 2–3 个 + 必须含「我不知道」
  "answerIndex": 1,                              // 正确选项下标（「我不知道」永不为答案）
  "answer": "思考也算输出字数，额度被吃光，正文就交白卷。", // ≤40 字
  "metaphor": "你雇了个爱打草稿的写手……",        // ≤80 字，生活比喻，不引入新术语
  "explain": "max_tokens 是…… finish_reason 是……", // ≤140 字，只讲机制
  "terms": [{"term": "max_tokens", "plain": "一次回复最多能吐多少字，思考也算。"}], // ≤3 个
  "takeaway": "以后看到「接口回了、正文空、还带一大段思考」，先看结束原因是不是 length。", // ≤50 字，格式：以后看到 X，先想到 Y
  "boundary": {                                  // 可选；L2+ 建议有
    "q": "换成不思考的模型也能解决吗？",
    "options": ["能", "不能", "看情况"],
    "answerIndex": 0,
    "explain": "能绕过，但会丢掉推理能力，要看场景。"
  },
  "figure": {                                    // 可选，但关系型概念必须有
    "type": "budget-bar",                        // 见 §5 图型表
    "caption": "预算是一根横条，先写草稿的人会把它先用完。",  // 必须是关系句
    "alt": "思考占满输出预算，正文长度为 0",
    "spec": { "total": 4096, "used": 4096, "segments": [{"label": "思考", "value": 4096}, {"label": "正文", "value": 0}] }
  },
  "quiz": [                                      // 1–3 道变式题；根据卡片内容联想，不是原题复述
    {
      "kind": "recall",                          // recall | apply | contrast | trace
      "q": "另一个项目里，接口返回成功但 content 为空，finish_reason=length。最可能是什么？",
      "options": ["模型不认识了", "输出额度不够", "网络断了"],
      "answerIndex": 1,
      "explain": "同一条：先看结束原因。"
    }
  ],
  "source": {
    "project": "example-project",
    "session": "session-4ccf89a0",               // 会话 id 前 8 位或完整 id
    "time": "2026-10-14 22:48",
    "seq": [1463, 1480],                         // 可选
    "quotes": [                                  // 1–3 条，必须逐字来自日志
      {"who": "user", "text": "出现了一些问题，现在接口返回出来的是思维链"},
      {"who": "assistant", "text": "思考过程把 max_tokens 吃光了，正文（content）是空的。"}
    ]
  },
  "crossProject": ["example-project-a", "example-project-b"], // 可选：这张卡还在哪些项目里出现过（跨项目联想）
  "createdAt": 1791958080000
}
```

**硬规矩（服务端会校验，不合格的卡直接拒收）**

1. `title ≤18`、`scene ≤80`、`question ≤40`、`answer ≤40`、`metaphor ≤80`、`explain ≤140`、`takeaway ≤50`（按字符数，中文算 1）。
2. 不展开总字数（title+scene+question+metaphor+explain+takeaway）**≤ 320**。
3. `terms ≤3`，每个 `plain ≤25`；`explain` 与 `metaphor` 里出现的术语必须在 `terms` 里或已用一句话解释。
4. `options` 必须 2–3 个，且**必须包含「我不知道」**；`answerIndex` 不能指向「我不知道」。
5. `source.quotes` 至少 1 条，且 **`text` 必须能在原始会话日志里逐字找到**（去空白后子串匹配）。找不到 = 拒收。
6. 卡片正文**不许出现第二人称失败叙述**（「你当时失败了 3 次」「你怎么连这个都不懂」）。
7. 标题**不许出现项目名、端口号、函数名**（这些只允许出现在 `scene` 和 `source`）。
8. `quiz` 不能用原 `question` 换皮；要换场景或换问法。

---

## 2. 概念 Concept

```jsonc
{
  "id": "token-budget",
  "name": "token 预算",
  "domain": "模型接口",        // 第一层：领域
  "problem": "接口为什么没返回内容", // 第二层：问题（用户脑子里的问句）
  "lane": "mechanism",         // 主归属线
  "desc": "一次回复允许输出的最大 token 数，思考内容也计入。", // ≤60 字
  "level": 3                   // 0..5，用户对该概念的理解深度（人看的是点阵）
}
```

## 3. 边 Edge

```jsonc
{ "from": "token-budget", "to": "empty-content", "kind": "cause", "reason": "预算被吃满，正文就没地方写" }
```

`kind` 只允许四种：`prereq`（前置）/ `cause`（因果）/ `contrast`（对比）/ `same`（同源）。
`reason` ≤20 字，写不出理由的边不要建。

---

## 4. 服务端 API

### GET `/api/bundle`

```jsonc
{
  "version": 1,
  "generatedAt": 1791958080000,
  "cards": [ /* Card[] */ ],
  "concepts": [ /* Concept[] */ ],
  "edges": [ /* Edge[] */ ],
  "stats": { "cards": 16, "concepts": 9, "byLane": {"mechanism": 8, "syntax": 6, "algorithm": 1, "judgment": 1} }
}
```

### POST `/api/review`

请求：`{ "cardId": "…", "action": "got" | "nope" | "too-easy" }`
响应：`{ "ok": true }`
只落库，不在 UI 上累计成"待复习 N 张"。

### POST `/api/quiz`

请求：`{ "cardId": "…", "quizIndex": 0, "picked": 1 }`
响应：`{ "ok": true, "correct": false }`

---

## 5. 图型 type 表（前端按 type 渲染 SVG）

| type | 用途 | spec 字段 |
|---|---|---|
| `budget-bar` | 预算/容量被吃满 | `{total, used, segments:[{label,value}]}` |
| `timeline` | 请求-响应、启动顺序 | `{steps:[{label, detail}]}` |
| `state` | 状态机 | `{nodes:[{id,label}], edges:[{from,to,label}]}` |
| `tree` | 依赖、目录 | `{root:{label, children:[…]}}` |
| `branch` | 命中/未命中、两条路 | `{question, yes:{label}, no:{label}}` |
| `code-diff` | 语法线：高亮改动行 | `{file, lines:[{no, text, mark:"add"|"del"|"same"}]}` |
| `compare` | 两个方案并排 | `{left:{label, cost}, right:{label, cost}}` |

图型必须能证明一个关系；写不出 `caption` 关系句的，删掉图。

---

## 6. 前端约束

- **单页、无构建、无 CDN、无外部字体**，`file://` 或本地 http 都能开。
- 只吃 `/api/bundle`；**不许把假数据写死进前端**（可以内置一份 `mock.json` 用于无服务端预览，但启动后必须走 fetch）。
- 视觉沿用 `../prototype/index.html` 的设计语言：纸色 `#f7f4ee`、墨色 `#1b1a17`、朱砂 `#b4432e`、宋体标题 + 苹方正文、发丝线分割。
- **Safari 优先**：用户日常用 Safari。不用 `:has()`、不用 `dialog` 新特性、不用顶层 await、不用 `Array.at` 以外的实验 API；ES2020 以内；`fetch` + `Promise`。
- 不显示：待复习数、连续天数、成长曲线、知识点总数、学习时长。
- 卡片正面只放：标题 / 场景 / 问题 / 选项。答案、图、术语、来源都在背面或折叠层。
- 「没懂，换个说法」「这张太简单」「看当时的现场」三个动作必须在卡片上可达。

---

## 7. 目录与写入边界

```
app/
  src/        ← Lead 写（scan/db/ingest/serve）
  public/     ← 前端写（index.html/app.js/style.css + mock.json）
  data/out/   ← 卡片工厂写（每张卡一个文件，或一个批量文件 cards-batch-1.json）
  data/packets/ ← Lead 生成的候选包（给卡片工厂读）
  docs/       ← 契约与说明
```

---

## 8. 工作流卡（shape = "workflow"）

工作流卡不进测验、不进复习队列，按「动作序列/场景」匹配。

```jsonc
{
  "id": "card-workflow-recon-before-edit",
  "shape": "workflow",
  "lane": "judgment",
  "conceptId": "recon-before-edit",
  "title": "改动牵动多处时，先侦察再动手",
  "scene": "同一类改动以前要来回三次；这次一次过，因为顺序换了。",
  "takeaway": "以后遇到「改一处会牵动很多处」的活，先只读侦察、再动一处。",
  "workflow": {
    "steps": [{"name": "定口径", "what": "先写清什么算对"}],           // ≥3
    "decisions": [{"q": "先定口径还是先动手？", "choice": "先定口径", "tradeoff": "多花 5 分钟省三次返工"}], // ≥3
    "scenarios": [{"name": "跨平台适配", "desc": "Mac 跑得通、Windows 报错", "example": null}]           // ≥3
  },
  "source": {"project": "crowd-rush", "session": "session-4a8b42f1"}
}
```

规则：
- `shape="workflow"` 的卡**不校验** options / answerIndex / quiz / terms / 总字数；
- 必须有 ≥3 个 steps、≥3 个 decisions、≥3 个 scenarios；
- `source.quotes` 可空（工作流是归纳，不是单次事件），但必须有 `source.project`；
- 场景里的 `example` 由 `POST /api/card/scenario` 按需生成，生成后写回。

---

## 7. v2 增补（2026-11-13）

> 本轮新增的字段/接口；旧字段未改，只是多了来源。

### 7.1 `/api/bundle` 多一个 `states`

```jsonc
"states": {
  "port-fallback": {
    "state": "taught",        // unknown | taught | practicing | known
    "s": 0.2,                 // 掌握度
    "rung": 0,                // G0–G4，学习档位（唯一档位源）
    "types": ["recall"],      // 答对过的题型
    "rungTypes": [],          // 本档已答对的题型（升档用）
    "rungAt": 0,              // 上次升档时间
    "lastSeen": 1794129988793,
    "corrects": 0
  }
}
```

**口径**：卡片流、概念图、旁听面板显示 G 档位时，一律读 `states[conceptId].rung`，不再按 `card.level` 或 `concept.level` 猜。

### 7.2 旁听 pending 里的卡片多 `rung`

`/api/whisper/detect` / `/api/whisper/pending` 返回的 `card` 对象新增 `rung`（0–4）与 `rungTypes`。

### 7.3 新接口

| 接口 | 说明 |
|---|---|
| `POST /api/card/rung` | `{cardId, action:"up"|"down"}` 手动调档，0–4 截断；返回 `{ok, rung, conceptId}` |
| `GET /api/locate?session=&seq=&quote=` | 「回到现场」：读 `$DSH_HOME/sessions` 日志，返回锚点前后消息；没有 seq 时按引文定位；`anchored` 表示有没有锚点 |
| `GET /api/kb/map` | 语义地图数据（`data/kb-map.json`，Isomap 坐标 + 64 维向量 + 项目热度） |
| `GET /api/kb/code-map` | 代码地图数据（`data/kb-code-map.json`，按来源文件聚类） |

### 7.4 `/api/guide/next` 与 `/api/guide/path` 可不带 conceptId

不带时从「前沿」自动挑一个概念（已在学、未到 G4、曝光多优先）；同领域兜底还在，不再返回 null 死路。

### 7.5 定位返回的边界（已核实）

DSH 桌面版没有「按 seq 跳到某条消息」的深链；`dsh-session:` 只是会话引用，`dsh://open` 只唤起窗口。所以「定位返回」实装成 `GET /api/locate` 回读原文，不依赖 DSH 提供跳转。

---

## 8. v2.1（2026-11-14）

### 8.1 行为档位：升降级全量启用

- 升档沿用原规则：答对两种不同题型 + 距上次升档 ≥7 天 → +1，最高 G4。
- 降档：`concept_state.wrong_streak` 连加两次答错 → rung−1（最低 G0），并把 `rung_at` 记为当下；`wrong_streak` 归零。答对一次清零。
- 手动「太浅了」仍 +1；「没懂」当档重讲，不降档。

### 8.2 卡片上限与隐藏

- `config.json` 新增 `cardLimit`（默认 50）；`GET /api/bundle` 的 `stats.cardLimit` 会带出。
- `ingest.mjs` 在写库前检查 **未学池**（concept_state 不是 known 的 active 卡 + 本次同条件卡）是否超过上限，超了直接退出，不静默丢卡。已会的卡隐藏、不占 50 个名额；复习答错（state 回到 practicing）会自动回到池里，所以卡片可轮训。
- 前端卡片流默认隐藏 `states[conceptId].state === 'known'` 的卡（左侧「已会 N 张」可展开）；深链到某张已会卡时仍会显示。
- 学会的卡同样不进入 `/api/whisper/detect` 的卡片匹配；KB 检索会过滤掉已被卡片覆盖的 `kb_<cardId>` 条目。复习答错后 state 变回 `practicing`，卡片自动回到卡片流与实时匹配（轮训）。

### 8.3 每周温故

| 接口 | 说明 |
|---|---|
| `GET /api/weekly?force=1` | 返回上一周（周一 00:00 到周日 23:59）的报告：涉及卡片、答题数/正确数、这些卡片对应的标签子图。`show` 由「启用日 2026-11-16 + 本周未读」决定；`force=1` 用于测试 |
| `POST /api/weekly/seen` | `{week:"2026-W46"}` 标记已读，写 `data/weekly.json` |

报告结构：`{week:{key,start,end}, stats:{cards,quizzes,correct,wrong,newCards}, cards:[…], tags:{nodes,links}, show, empty}`。
前端在 `loadData` 后请求一次；`show=true` 时弹「上周温故」，默认开启温故模式（显示卡片 + 标签网络），关闭后本周不再弹。
