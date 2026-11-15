# 知识库分片规则 v0.1

> 适用对象：`doc.md`（学习小助手知识库基础文档）这种「一条知识一个小节」的 Markdown。
> 一句话：**一条知识 = 一个 chunk。标题、正文、引文、来源必须待在同一片里，永远不按段落切。**

---

## 1. 为什么要单独立规则

你现在这版切出来是这样：

```
[0] # 学习小助手… + 01 的 ID/一句话/正文/引文…
[1] ## 01 窗口开出来了，画面是 0×0        ← 只剩一个标题
[2] 05 界面说连不上…的正文                ← 和标题分家了
[3] ## 07 屏幕不对，套个文件更不对         ← 07 的标题
[4] 03 开关是开的…的正文                  ← 内容却是 03
```

后果不是“难看”，是**检索直接坏掉**：

- embedding 里只有标题、没有内容 → 搜「0×0」搜不到；
- 内容片没有标题和引文 → 召回后无法展示、无法定位；
- 标题和正文错位 → 分数看着有，答案对不上。

根因：按空行/固定长度切，而不是按 `### ` 边界切。

---

## 2. 硬规则（10 条）

| # | 规则 |
|---|---|
| 1 | **分片单位 = 一条知识**：从 `### ` 开始，到下一个 `### ` 或 `## ` 之前结束。禁止按段落、按字数切。 |
| 2 | **结构块不进 chunk**：文档前言、字段说明表、`## 机制线（9 条）`、`---`、`## 导入建议`，全部跳过。 |
| 3 | **每片必须齐五件**：`ID`、`一句话`、`正文`、`原文引文`、`来源`。缺一件就拒收，不进库。 |
| 4 | **embedding 文本** = 标题 + 一句话 + 正文 + 引文；**不要**把来源、标签、所以句混进去（它们是元数据/与正文重复）。 |
| 5 | **document（展示用）** = 完整条目（含所以句）；检索只返回 `summary + 引文前 12–20 字`，点开再取 document。 |
| 6 | **id 用文档里的 `kb_<card_id>`**，不要用序号；重建文档后 id 不能漂。 |
| 7 | **长度**：单条 200–600 字。超 600 才拆，拆点固定在「原文引文」前；第二片保留「标题 + 引文 + 来源」。 |
| 8 | **工作流条目**单独一片，metadata 标 `type=workflow`，允许没有引文（它本来就是归纳）。 |
| 9 | **幂等**：入库用 `upsert`，id 用 `chroma_id`；同一内容重复导入不新增。 |
| 10 | **校验**：切完 `chunk 数 == 条目数`；每片第一行是标题；每片有引文（工作流除外）。 |

---

## 3. metadata 怎么放

```json
{
  "chroma_id": "kb_card-example-project-zero-size-window",
  "title": "窗口开出来了，画面是 0×0",
  "section": "机制线",
  "lane": "mechanism",
  "concept": "布局约束",
  "project": "example-project",
  "session": "session-4ccf89a0",
  "anchor": "seq=2702,2712",
  "confidence": "A",
  "type": "knowledge"
}
```

- `project / session / anchor` 是「定位返回」要用的，必须从 `来源` 里拆出来；
- `lane` 从所在小节映射（机制线→mechanism，语法线→syntax，算法线→algorithm，判断线→judgment）；
- `confidence` 只收 A/B，C 不进主库。

---

## 4. 工具

- `kb_chunk.py`：按上述规则切，输出 `doc_chunks.jsonl`（每条含 id / title / summary / text / quote / source / tags / concept / confidence / section / document / embed_text）。
- 用法：

```bash
cd ~/learning-assistant      # 或 doc.md 所在目录
python3 kb_chunk.py doc.md --out doc_chunks.jsonl
# chunks=18  缺 ID/引文/来源：0
```

- 如果你用 LangChain 的 `MarkdownHeaderTextSplitter`：必须 `strip_headers=False` 且只用 `[("###","entry")]` 一级，否则标题会被剥掉；更稳的是直接用上面的脚本产出 JSONL，跳过 splitter。

---

## 5. 入库前再验一次（可选但建议）

1. `quote` 是否能在对应 session 的原文里逐字找到（去空白后子串匹配）；
2. `chroma_id` 是否与卡片库 `covered_by_card` 一致（用于“知识库查到了但卡片已覆盖”的去重）；
3. 抽样 3 条，人工读一遍：摘要能否独立看懂。

---

## 6. 已知边界

- 一条知识如果正文超过 600 字，说明它该被拆成两条知识，而不是切两片——**先拆条，再切块**。
- 不要在 chunk 里放整段对话；引文只留能证明结论的那 1–2 句。
