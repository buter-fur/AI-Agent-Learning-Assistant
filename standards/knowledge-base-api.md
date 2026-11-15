# 知识库接口 v0.2（草案）

> 定位：学习小助手只负责「什么时候问、问到什么、怎么讲」；**知识库本体由你自己搭**（向量库/文件/数据库都行）。
> 我们只约定一层 HTTP/JSON 接口，任何实现只要满足这份契约就能接进来。

---

## 0. 总体形状

```
watch（会话嗅探）
   → POST /api/whisper/detect（本机 4780）
        → ① 先在本机卡片池匹配（现有逻辑，引文可核验）
        → ② 卡片没命中 / 命中太弱 → 调知识库 POST /search
        → ③ 知识库也没命中 → 静默（留给离线生成）
```

- 知识库服务建议只绑 `127.0.0.1`，默认端口 `8790`（可改）。
- 所有接口 `Content-Type: application/json; charset=utf-8`。
- 失败一律“软失败”：小助手降级到卡片池，不阻塞、不报错弹窗。

---

## 1. 健康检查

`GET /health`

```json
{ "ok": true, "version": "0.1", "count": 1280, "dim": 1024, "embedModel": "bge-m3" }
```

用途：启动时探测一次；失败则本会话内不再调用（熔断 60 秒）。

---

## 2. 检索（命中过去的知识）

`POST /search`

```json
{
  "query": "为什么关掉窗口端口还被占用",
  "k": 5,
  "minScore": 0.35,
  "filters": { "project": "学习小助手", "lane": "mechanism", "since": "2026-09-01" }
}
```

返回：

```json
{
  "items": [
    {
      "id": "kb_01J8Z3...",
      "score": 0.72,
      "title": "关窗口不等于关进程",
      "summary": "一句话：界面退了，进程可能没退。",
      "quotePreview": "关窗口不等于关进程，先看是…",   // 只给 12–20 字预览
      "hasMore": true,                              // 详情要点开才拉
      "source": {
        "project": "示例项目",
        "session": "session-4a8b42f1",
        "quote": "关窗口不等于关进程，先看是谁占着端口",
        "anchor": "turn=12;seq=418..421"
      },
      "tags": ["端口", "进程", "机制"],
      "confidence": "A",
      "updatedAt": 1794130000000
    }
  ],
  "tookMs": 84
}
```

硬要求：
- `score` 必须在 `[0,1]`，且与 `minScore` 同一尺度（余弦相似度需归一化）。
- `source.quote` 必须能回到原文；拿不到就**不要返回这一条**。
- 没有结果返回 `{"items":[]}`，不要返回 404。

---

## 2.1 详情（点开才拉全文）

`GET /item/{id}`

```json
{
  "id": "kb_01J8Z3...",
  "title": "关窗口不等于关进程",
  "summary": "界面退了，进程可能没退。",
  "text": "完整正文（≤800 字）……",
  "quotes": [
    { "text": "关窗口不等于关进程，先看是谁占着端口", "project": "示例项目", "session": "session-4a8b42f1", "anchor": "turn=12;seq=418..421" }
  ],
  "tags": ["端口", "进程"],
  "confidence": "A"
}
```

> 设计：**检索只给摘要 + 十几个字的引文预览**，点「看原文」才拉全文。
> 好处：弹卡快、不剧透、也不把长文塞进列表。

---

## 3. 写入（输入新的知识）

`POST /upsert`

```json
{
  "mode": "merge",
  "items": [
    {
      "id": "kb_可选_不传则按内容哈希生成",
      "title": "关窗口不等于关进程",
      "text": "窗口只是界面……（≤800 字）",
      "summary": "一句话点破",
      "source": {
        "project": "示例项目",
        "session": "session-4a8b42f1",
        "quote": "关窗口不等于关进程，先看是谁占着端口",
        "anchor": "turn=12;seq=418..421"
      },
      "tags": ["端口", "进程"],
      "lane": "mechanism",
      "confidence": "A",
      "createdAt": 1794130000000
    }
  ]
}
```

返回：

```json
{
  "ok": true,
  "created": 1,
  "updated": 0,
  "skipped": [{ "index": 1, "reason": "quote 在原文中找不到" }]
}
```

语义：
- **幂等**：不传 `id` 时，服务端按 `sha256(规范化 text + source.quote)` 生成；同一内容重复提交只更新 `updatedAt`。
- **merge**：同 `id` 合并（保留旧 quote，新 quote 追加，`updatedAt` 取新）；**replace**：整条替换。
- 校验不过的条目进 `skipped` 并给原因，**不要整批失败**。

---

## 4. 小助手侧客户端（`app/src/kb.mjs`，待实装）

```js
// 配置（config.json 增加）
"kb": {
  "enabled": true,
  "baseURL": "http://127.0.0.1:8790",
  "collection": "learning_kb",
  "timeoutMs": 800,
  "popThreshold": 0.60,
  "gateThreshold": 0.35,
  "embedModel": "bge-m3"
}

export async function search(query, opts) // 失败返回 []，并记一次失败
export async function upsert(items)       // 失败返回 {ok:false}
export async function health()            // 启动探测
```

- **超时**：检索 800ms、写入 5s；超时直接放弃本轮。
- **熔断**：连续 3 次失败 → 停用 60 秒（避免每次嗅探都卡在超时上）。
- **埋点**：`data/kb-log.jsonl` 记 `{ts, op, query, hits, topScore, tookMs, ok}`，方便你回看命中率。

---

## 5. 匹配顺序（v0.2，按你的意见调整）

方案定为「三级闸门 + 一条后台补位」：

```
信号进来
 ├─ ① 卡片匹配（<100ms）
 │    命中且 sim ≥ 0.12 → 立即弹卡片 ✅（最快路径）
 │         └─ 后台（不阻塞）：拿这张卡的 title+takeaway 当「已覆盖」去查知识库
 │               → 找到卡片没讲的角度 → 稍后出一条「补充：卡片没讲的案例」角标
 ├─ ② 卡片没命中 → 知识库检索（embedding+Chroma，约 50–150ms）
 │    top.score ≥ 0.60 → 立即弹「知识卡」（摘要 + 引文预览）
 │    0.35 ≤ score < 0.60 → 进模型闸门（见 ③），过则角标、不过则丢
 └─ ③ 都没有 → 静默，进候选池
```

**模型闸门（27B）不放在关键路径上。** 理由：Q5 的 27B 一次判断要 5–8 秒，等它就错过时机了。折中：

- `score ≥ 0.60` 直接弹，不让模型等；
- 灰区 `0.35–0.60` 才调模型（此时宁可慢 6 秒也别弹错）；
- 「卡片已有、知识库补位」是**后台任务**，不影响弹出速度，结果只出角标。

**去重输入**：调模型时把「当前命中的卡片内容 + 最近 24h 弹过的知识 id」一起塞进去，让它只挑卡片没覆盖的角度：

```json
{
  "signal": "为什么关掉窗口端口还占用",
  "card": { "title": "端口被占了，它自己往后挪", "takeaway": "…" },
  "candidates": [ { "id": "kb_...", "summary": "…", "score": 0.52 } ],
  "ask": "只保留卡片没讲到的角度；重复或同义就返回空"
}
```

**为什么卡片优先仍然成立**：卡片经过引文校验、有教学结构和掌握度，讲出来更稳；知识库是“查到的”，快但质量参差。两者都弹，但**卡片先、KB 后**，用户的体感是“先给我最熟的，再补我没有的”。

---

## 6. 收进卡片库（可选，但建议做）

参考卡上给一个「收进卡片库」：调小助手现有生成流程，把该条知识变成正式卡（补比喻、图、题、边界），入库前仍过引文闸门。这样知识库只负责“发现”，卡片负责“教”。

---

## 7. Chroma 落点（你选 ChromaDB）

- collection：`learning_kb`，metadata 至少存 `project / lane / confidence / session / updatedAt / card_id`（`card_id` 用于「这条已被某张卡片覆盖」）；
- `where` 过滤直接映射接口里的 `filters`；
- 检索用 `query_texts=[query]` 让 Chroma 自带 embedding，或先本地 bge-m3 算好再 `query_embeddings=`（后者更快、模型可控）；
- 建议 id 用 `kb_<sha1(text)[:16]>`，重复写入用 `upsert`。

## 8. 还需要你点头的一处

上面的「三级闸门」里，**灰区（0.35–0.60）才等模型 5–8 秒**——能接受吗？
如果不能接受，就改成「灰区也只出角标、后台再判」，速度最快。
