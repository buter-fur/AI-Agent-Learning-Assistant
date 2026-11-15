# 学习小助手 · 卡片站与知识库

从 DSH 会话日志里提取开发片段，做成可学的卡片；配一套知识库检索与标签标准。

## 需要

- Node.js **≥ 22.13**（使用内置 `node:sqlite`）
- 可选：本地 Ollama（灰区判定 / 本地生成）、Chroma 知识库服务（`~/rag/kb_server.py`，8790）。没有本地模型也可以：示例配置默认关闭本地模型，灰区判定会自动改用设置里的 API 做小请求；有 Ollama 时把 `localJudge.enabled` 改 `true`。

## 启动

```bash
cp config.example.json config.json
# 打开 config.json，填 apiKey（也可以用 OPENAI_API_KEY 环境变量）
node src/serve.mjs --open
```

默认地址 `http://127.0.0.1:4780`。示例配置默认 `thinking: {type: "disabled"}`，避免部分账号只回思考、不给正文；换非 DeepSeek 端点时删掉这个字段。没有卡片数据时会加载 `public/mock.json` 的合成示例；服务首次启动会在 `data/cards.db` 自动建空库。

> 改过 `public/` 下的前端文件：刷新页面即可。改过 `src/` 下的 Host 半边（serve/kbmap 等）：需要重启一次 DSH（或插件停用/启用）才会跑新代码。

**设置页**：`http://127.0.0.1:4780/settings.html`，不依赖 DSH 插件也能填 API、模型、优先级和回溯范围。

## 知识缓存（知识地图的数据源）

知识地图不要求本地模型或 Chroma 知识库：`kb_log` 表专门存知识条目，**不受 50 张卡上限约束**，卡片、历史补卡、种子卡会自动同步进来，也可以在「知识地图 → 管理知识缓存」里手动增删改。

- 服务启动时自动补齐；条目或卡片有变化时，下一次地图请求会重建（几百条 <1s）。
- 手动重建：`node src/kbmap.mjs`（只同步卡片不重建：`node src/kbmap.mjs --sync`）。
- 生成物仍是 `data/kb-tags.json`、`data/kb-code-map.json`、`data/kb-map.json`，将来接回 Chroma 知识库时可原样覆盖。
- 标签用 `standards/tag-map.json` 的受控词表 + 规则做确定性归类；语义地图默认用字符 bigram TF-IDF + PCA；检索兜底用同一份缓存的加权关键词覆盖打分。
- **可选远程 embedding**：设置页「语义地图 · 远程 Embedding」可接任何 OpenAI 兼容 `/v1/embeddings`（OpenAI / SiliconFlow / 阿里百炼 / 自建）。不接也能用，语义地图会如实标注“本地字面相似度、未接 embedding”，不冒充语义结果；接了以后向量按内容哈希缓存在 `data/embeddings.json`，重复重建不重复花钱。协议与配置见 `docs/CONTRACT.md` 第 10 节。
- 卡片池到 50 张上限时，被拒绝的历史卡 / 种子卡仍会写进知识缓存，不会丢知识。

## Windows

- 双击 `启动学习小助手.bat`；或在该目录执行 `node src\serve.mjs --open`。
- 需要 Node.js ≥ 22.13；`chcp 65001` 已在 .bat 里设置，避免中文输出乱码。
- 不需要 Python、Chroma 或 zstd 才能启动卡片站；知识库/本地模型是可选增强。
- 配置入口：`http://127.0.0.1:4780/settings.html`。

## 数据与隐私

仓库**不包含**个人会话日志、卡片数据库、知识库正文、API Key。运行时生成的文件都在 `data/`，已被 `.gitignore` 排除。

## 主要入口

- `src/serve.mjs`：卡片站 HTTP 服务
- `src/db.mjs`：SQLite schema（卡片/概念/复习/历史/种子/知识缓存/扫描开关）
- `src/kbmap.mjs`：知识缓存同步、标签/代码/语义地图生成、本地检索兜底
- `src/embed.mjs`：远程 embedding 提供商接口（OpenAI 兼容协议、缓存、连通性自检）
- `src/whisper.mjs`：实时匹配与价值分档
- `src/history.mjs`：旧会话补卡
- `src/seed.mjs`：主动发现的种子卡
- `src/llm.mjs`：OpenAI 兼容客户端
- `public/`：卡片站前端
- `docs/CONTRACT.md`：卡片 JSON 契约

知识库与卡片标准不在这里，在仓库根目录 `standards/`；空知识库模板在 `knowledge-base/`。
