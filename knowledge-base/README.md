# 知识库模板

这里放的是**空框架**，不包含任何个人会话数据。

## 一条知识的最小结构

```md
### 一句话标题（6–40 字）

一句话结论（恰好 1 句，不用省略号）。

- 标签：标签A、标签B、标签C
- 来源：项目 / 会话 / 时间
- 引文：「逐字原文」
```

规则以 [`../standards/knowledge-base-content.md`](../standards/knowledge-base-content.md) 和 [`../standards/knowledge-base-chunking.md`](../standards/knowledge-base-chunking.md) 为准。

## 从空库开始

1. 复制 `doc.template.md` 为 `doc.md`；
2. 按标准逐条补内容；
3. 标签优先从 [`../standards/tag-map.json`](../standards/tag-map.json) 的受控词表里选，缺词才补词表；
4. 接 Chroma 时，`doc.md` 里一个 `###` 对应一条知识；检索接口见 `../standards/knowledge-base-api.md`。

## 约束

- 不提交个人 `doc.md`、`cards.db`、会话日志、API Key。
- 每条至少 2 个、最多 5 个标签；标签必须在词表内。
- 引文必须能在原始会话里逐字找到；找不到就删掉这条。
