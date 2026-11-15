# 学习小助手 · 知识与卡片标准

这套标准回答四个问题：

1. **什么内容能进知识库**：`knowledge-base-content.md`
2. **一条知识怎么切、怎么检索**：`knowledge-base-chunking.md` + `knowledge-base-api.md`
3. **卡片和知识库怎么分工**：`card-library-and-kb.md`
4. **卡片怎么讲、怎么判、怎么升级**：`four-lanes.md`、`teach-example-test.md`、`behavior-levels.md`、`gradient-and-guide.md`、`value-and-repetition.md`

## 文件索引

| 文件 | 内容 |
|---|---|
| `knowledge-base-content.md` | 知识库条目字段、长度、引文、去重、可信度、禁止入库 |
| `knowledge-base-chunking.md` | 一条 = 一个 `###`；一句话定义；分块与检索粒度 |
| `knowledge-base-api.md` | 检索/写入的 HTTP 契约、分数与超时 |
| `card-library-and-kb.md` | 卡片库与知识库的边界、入库顺序、重复处理 |
| `four-lanes.md` | 机制 / 语法 / 算法 / 判断四条线的分法 |
| `teach-example-test.md` | 先讲、再例、后测；卡片三段式与变式题 |
| `behavior-levels.md` | G0–G4 行为判级、升降档规则 |
| `gradient-and-guide.md` | 难度阶梯、引导入口、缺口 |
| `value-and-repetition.md` | 价值分、时机分、遗忘曲线、推送阈值 |
| `weekly.md` | 每周温故的范围与标签网络 |
| `tag-map.json` | 受控标签词表（canon） |
| `tag_rules.py` | 标签校验/归一化工具 |

## 两条底线

- **引文必须逐字命中**原始会话；编的句子宁可不要。
- **上限要显式失败**：卡片到 50 张、标签不在词表、字段超长时，拒绝写入并说明原因，不静默截断或覆盖。
