# 学习小助手 · 卡片站与知识库

从 DSH 会话日志里提取开发片段，做成可学的卡片；配一套知识库检索与标签标准。

## 需要

- Node.js **≥ 22.13**（使用内置 `node:sqlite`）
- 可选：本地 Ollama（灰区判定 / 本地生成）、Chroma 知识库服务（`~/rag/kb_server.py`，8790）

## 启动

```bash
cp config.example.json config.json
# 打开 config.json，填 apiKey（也可以用 OPENAI_API_KEY 环境变量）
node src/serve.mjs --open
```

默认地址 `http://127.0.0.1:4780`。没有卡片数据时会加载 `public/mock.json` 的合成示例；服务首次启动会在 `data/cards.db` 自动建空库。

**设置页**：`http://127.0.0.1:4780/settings.html`，不依赖 DSH 插件也能填 API、模型、优先级和回溯范围。

## 数据与隐私

仓库**不包含**个人会话日志、卡片数据库、知识库正文、API Key。运行时生成的文件都在 `data/`，已被 `.gitignore` 排除。

## 主要入口

- `src/serve.mjs`：卡片站 HTTP 服务
- `src/db.mjs`：SQLite schema（卡片/概念/复习/历史/种子/扫描开关）
- `src/whisper.mjs`：实时匹配与价值分档
- `src/history.mjs`：旧会话补卡
- `src/seed.mjs`：主动发现的种子卡
- `src/llm.mjs`：OpenAI 兼容客户端
- `public/`：卡片站前端
- `docs/CONTRACT.md`：卡片 JSON 契约

知识库与卡片标准不在这里，在仓库根目录 `standards/`；空知识库模板在 `knowledge-base/`。
