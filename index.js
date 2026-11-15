/**
 * 学习小助手 · DSH Host 半边。
 *
 * 两件事：
 *   1. 旁听当前进程里每个顶层会话的 user/message 与 tool/result，把「为什么」
 *      和「非操作性报错」转给本地学习小助手服务（默认 127.0.0.1:4780）。
 *      真正的匹配/分档/待看队列都在学习小助手那边，这里只做搬运。
 *   2. 注册一个同源反向代理 /learning-assistant/*，浏览器半边用它轮询
 *      pending/queue、确认卡片、拉取知识全文，避免跨域。
 *
 * 这个文件不 import 任何包：插件安装在 profile 里，node_modules 只包含
 * profile 自己的依赖；所有能力都从 ctx 或 Node 全局拿。
 *
 * @module dsh-plugin-learning-assistant
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 同源代理前缀。 */
const PREFIX = "/learning-assistant";
/** 学习小助手默认端口。 */
const DEFAULT_BASE = "http://127.0.0.1:4780";
/** 请求体上限，避免代理被大文件撑爆。 */
const MAX_BODY = 2 * 1024 * 1024;
/** 空闲/掉线后多久再尝试，避免每个事件都打一次。 */
const RETRY_AFTER_MS = 30000;
/** 工具层的操作性报错不是学习素材。 */
const OPERATIONAL = /(^FS_)|cannot (edit|modify)|old_string was not found|file has been modified|sandbox|aborted|must differ|no changes/i;
/** 用户表示困惑/追问的信号。 */
const WHY = /为什么|为啥|怎么回事|不对|不是吧|看不懂|没看懂|怎么搞|有没有搞错/;
/** 助手在任务里讲出「值得记」的判断时，不再等用户发问。 */
const VALUE = /本质|取舍|关键(是|在)|原则|结论(是|：)|记住|重点(是|在)|坑(在|是)|以后(看到|遇到)|先.{0,8}再|不是.{1,12}而是/;

/** 插件本体所在目录；默认从它的隔壁找学习小助手。 */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_APP_DIR = path.join(path.resolve(PLUGIN_DIR, ".."), "学习小助手", "app");
const REPO_APP_DIR = path.join(PLUGIN_DIR, "app");
const DEFAULT_APP_DIR = fs.existsSync(path.join(LOCAL_APP_DIR, "src", "serve.mjs"))
	? LOCAL_APP_DIR
	: REPO_APP_DIR;
const DEFAULT_KB_DIR = path.join(process.env.HOME || os.homedir(), "rag");
const DEFAULT_OLLAMA_BIN = process.platform === "win32"
	? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "Ollama", "ollama.exe")
	: "/opt/homebrew/bin/ollama";

/** 用本地 HTTP 探活，失败/超时都返回 null。 */
async function probeJson(url, timeoutMs = 1000) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: ctrl.signal });
		if (!response.ok) return null;
		return await response.json().catch(() => null);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** 展开 ~ 并把配置路径按插件目录解析。 */
function resolveConfiguredPath(value, fallback) {
	let raw = typeof value === "string" && value.length > 0 ? value : fallback;
	if (raw === "~" || raw.startsWith("~/")) raw = path.join(os.homedir(), raw.slice(2));
	return path.resolve(PLUGIN_DIR, raw);
}

/** 在端口区间里找已经起着的卡片站，避免重复拉起。 */
async function findCardBase(startPort, count = 20) {
	const urls = [];
	for (let port = startPort; port < startPort + count; port += 1) {
		urls.push(`http://127.0.0.1:${port}`);
	}
	const found = await Promise.all(urls.map(async (url) => {
		const health = await probeJson(url + "/api/health", 1400);
		return health && health.ok === true ? url : null;
	}));
	return found.find(Boolean) || null;
}

/** 从事件 content 里取纯文本。 */
function textOf(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/** 读取请求体。 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, value) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(value));
}

/** 用 DSH 已配置的模型路由生成一段正文；历史补课的最终兜底。 */
async function dshGenerate(llm, system, user) {
	const providers = llm.listProviders();
	if (!providers.length) throw new Error("DSH 没有已注册的模型提供方");
	const provider = providers.find((p) => p.id === "deepseek-account")
		|| providers.find((p) => /deepseek/i.test(p.id))
		|| providers[0];
	const models = await llm.listModels(provider.id);
	if (!models.length) throw new Error("DSH 模型目录为空");
	const model = models.find((m) => /flash/i.test(m.id)) || models[0];
	let text = "";
	for await (const chunk of llm.stream({
		provider: provider.id,
		model: model.id,
		system,
		messages: [{ role: "user", content: [{ type: "text", text: user }] }],
		temperature: 0.35,
		maxTokens: 4096
	})) {
		if (chunk.type === "text-delta") text += chunk.text;
		if (chunk.type === "finish" && chunk.reason && chunk.reason.kind === "error") {
			const failure = chunk.reason.failure || {};
			throw new Error(failure.message || failure.code || "DSH 模型请求失败");
		}
	}
	if (!text.trim()) throw new Error("DSH 模型只返回了思考，没有正文");
	return text;
}

/** 历史补课：本地/API 由卡片站处理；它说需要 DSH 时，这里接手生成。 */
async function scanHistoryVia(base, body, getLlm) {
	const response = await fetch(base + "/api/history/scan", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body || {})
	});
	const data = await response.json().catch(() => ({ ok: false, error: "卡片站返回了非 JSON" }));
	if (!response.ok || !data.needsDsh) return data;

	const llm = getLlm();
	if (!llm) return { ok: false, error: "DSH 模型服务没接上；暂时不能补历史", candidates: data.candidates || [] };

	const items = [];
	const modelErrors = [];
	for (const candidate of data.candidates || []) {
		try {
			const text = await dshGenerate(llm, candidate.system, candidate.user);
			items.push({ candidateId: candidate.id, text });
		} catch (error) {
			modelErrors.push({ candidateId: candidate.id, error: String(error && error.message || error) });
		}
	}
	if (!items.length) {
		return { ok: false, error: "DSH 内置模型没有生成内容", modelErrors: modelErrors.slice(0, 4) };
	}
	const imported = await fetch(base + "/api/history/import", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ items, scanId: data.scanId })
	});
	const result = await imported.json().catch(() => ({ ok: false, error: "导入失败" }));
	return { ...result, engine: "DSH 内置模型", modelErrors: modelErrors.slice(0, 4) };
}

/** 同源代理：浏览器请求 /learning-assistant/* → 本地学习小助手。 */
function proxyHandler(getBase, getLlm) {
	return async (req, res) => {
		const url = new URL(req.url || "/", "http://127.0.0.1");
		const origin = req.headers.origin;
		if (origin) {
			res.setHeader("access-control-allow-origin", origin);
			res.setHeader("vary", "Origin");
			res.setHeader("access-control-allow-methods", "GET,HEAD,POST,OPTIONS");
			res.setHeader("access-control-allow-headers", "content-type");
			res.setHeader("access-control-max-age", "600");
		}
		if (url.pathname === PREFIX) {
			return sendJson(res, 200, { ok: true, baseURL: getBase() });
		}
		if (!url.pathname.startsWith(PREFIX + "/")) {
			return sendJson(res, 404, { ok: false, error: "not found" });
		}
		const method = req.method || "GET";
		if (method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (method !== "GET" && method !== "HEAD" && method !== "POST") {
			return sendJson(res, 405, { ok: false, error: "method not allowed" });
		}

		let body;
		if (method === "POST") {
			try {
				body = await readBody(req);
			} catch (error) {
				return sendJson(res, 413, { ok: false, error: String(error.message || error) });
			}
		}

		if (method === "POST" && url.pathname === PREFIX + "/api/history/scan") {
			let parsed = {};
			try { parsed = body && body.length ? JSON.parse(body.toString("utf8")) : {}; } catch { parsed = {}; }
			try {
				const data = await scanHistoryVia(getBase(), parsed, getLlm);
				return sendJson(res, 200, data);
			} catch (error) {
				return sendJson(res, 502, { ok: false, error: String(error && error.message || error) });
			}
		}

		const base = getBase();
		const target = base + url.pathname.slice(PREFIX.length) + url.search;
		const ctrl = new AbortController();
		const timeoutMs = url.pathname === PREFIX + "/api/seed/expand" ? 180000 : 30000;
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const upstream = await fetch(target, {
				method,
				headers: {
					"content-type": req.headers["content-type"] || "application/json"
				},
				body,
				signal: ctrl.signal
			});
			const buffer = Buffer.from(await upstream.arrayBuffer());
			res.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
				"cache-control": "no-store"
			});
			res.end(buffer);
		} catch (error) {
			sendJson(res, 502, {
				ok: false,
				error: "learning-assistant offline",
				detail: String(error && error.message || error)
			});
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Cordis 插件名。 */
const name = "learning-assistant";

/** 需要 Web 路由注册表。 */
const inject = [];

/**
 * @param ctx Cordis 上下文。
 * @param config 行配置；`baseURL` 指向学习小助手服务。
 */
function apply(ctx, config) {
	const rawBase = config && typeof config.baseURL === "string" ? config.baseURL : DEFAULT_BASE;
	let base = rawBase.replace(/\/+$/, "");
	const log = ctx.logger || console;
	const sessions = new Map();
	let offlineUntil = 0;
	let warned = false;

	// 自动拉起本地服务；插件卸载/停用时只停自己拉起的进程。
	const appDir = resolveConfiguredPath(config && config.appDir, DEFAULT_APP_DIR);
	const kbDir = resolveConfiguredPath(config && config.kbDir, DEFAULT_KB_DIR);
	const autoStartOllama = !(config && config.autoStartOllama === false);
	let ollamaBin = config && typeof config.ollamaBin === "string"
		? config.ollamaBin
		: (fs.existsSync(DEFAULT_OLLAMA_BIN) ? DEFAULT_OLLAMA_BIN : "");
	if (ollamaBin === "~" || ollamaBin.startsWith("~/")) ollamaBin = path.join(os.homedir(), ollamaBin.slice(2));
	let parsedBase = null;
	try { parsedBase = new URL(base); } catch { parsedBase = null; }
	const localBase = !parsedBase || ["127.0.0.1", "localhost", "::1"].includes(parsedBase.hostname);
	const cardPortStart = Number(parsedBase && parsedBase.port) || 4780;
	const autoLog = path.join(appDir, "data", "auto-start.log");
	let cardChild = null;
	let kbChild = null;
	let ollamaChild = null;
	let disposed = false;
	let starting = null;
	let autoTimer = null;
	const owned = new Set();

	function spawnTracked(command, args, cwd, label) {
		let out = "ignore";
		try {
			fs.mkdirSync(path.dirname(autoLog), { recursive: true });
			out = fs.openSync(autoLog, "a");
		} catch {}
		const env = { ...process.env };
		if (path.resolve(command) === path.resolve(process.execPath)) env.ELECTRON_RUN_AS_NODE = "1";
		let child;
		try {
			child = spawn(command, args, { cwd, env, stdio: ["ignore", out, out] });
		} catch (error) {
			log.warn?.("learning-assistant: failed to start %s (%s)", label, String(error && error.message || error));
			if (typeof out === "number") { try { fs.closeSync(out); } catch {} }
			return null;
		}
		owned.add(child);
		child.once("error", (error) => {
			log.warn?.("learning-assistant: %s error (%s)", label, String(error && error.message || error));
		});
		child.once("exit", (code, signal) => {
			owned.delete(child);
			if (typeof out === "number") { try { fs.closeSync(out); } catch {} }
			if (!disposed) log.info?.("learning-assistant: %s exited (%s / %s)", label, code, signal || "signal");
		});
		log.info?.("learning-assistant: started %s (pid %s)", label, child.pid);
		return child;
	}

	function localJudgeEnabled() {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(appDir, "config.json"), "utf8"));
			return !!(raw.localJudge && raw.localJudge.enabled !== false);
		} catch {
			return false;
		}
	}

	async function ensureCard() {
		const existing = await probeJson(base + "/api/health", 1400);
		if (existing && existing.ok === true) return base;
		if (!localBase) return null;
		const found = await findCardBase(cardPortStart, 20);
		if (found) { base = found; return found; }
		const entry = path.join(appDir, "src", "serve.mjs");
		if (!fs.existsSync(entry)) {
			log.warn?.("learning-assistant: card station not found at %s", entry);
			return null;
		}
		cardChild = spawnTracked(process.execPath, ["src/serve.mjs", "--port", String(cardPortStart)], appDir, "card-station");
		if (!cardChild) return null;
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline && !disposed) {
			const hit = await findCardBase(cardPortStart, 20);
			if (hit) { base = hit; return hit; }
			await new Promise((resolve) => setTimeout(resolve, 350));
		}
		log.warn?.("learning-assistant: card station did not become healthy in 20s");
		return null;
	}

	async function ensureKb() {
		const health = await probeJson("http://127.0.0.1:8790/health", 1400);
		if (health && health.ok === true) return;
		const python = process.platform === "win32"
			? path.join(kbDir, ".venv", "Scripts", "python.exe")
			: path.join(kbDir, ".venv", "bin", "python");
		const script = path.join(kbDir, "kb_server.py");
		if (!fs.existsSync(python) || !fs.existsSync(script)) return;
		kbChild = spawnTracked(python, [script], kbDir, "kb-server");
	}

	async function ensureOllama() {
		if (!autoStartOllama || !ollamaBin || !localJudgeEnabled()) return;
		const health = await probeJson("http://127.0.0.1:11434/api/tags", 800);
		if (health) return;
		ollamaChild = spawnTracked(ollamaBin, ["serve"], os.homedir(), "ollama");
	}

	async function ensureServices() {
		if (starting) return starting;
		starting = (async () => {
			const kb = ensureKb();
			const ollama = ensureOllama();
			const card = await ensureCard();
			await Promise.allSettled([kb, ollama]);
			if (!card && !disposed) log.warn?.("learning-assistant: card station unavailable");
		})().catch((error) => {
			log.warn?.("learning-assistant: autostart failed (%s)", String(error && error.message || error));
		}).finally(() => { starting = null; });
		return starting;
	}

	function killOwned() {
		for (const child of owned) {
			try { child.kill("SIGTERM"); } catch {}
		}
		owned.clear();
	}

	const onExit = () => { killOwned(); };
	process.once("exit", onExit);

	/** 把一条信号交给学习小助手；失败静默退避，不打扰用户。 */
	async function detect(sessionId, kind, text, extra) {
		if (!text || typeof text !== "string") return;
		if (Date.now() < offlineUntil) return;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 25000);
		try {
			const response = await fetch(base + "/api/whisper/detect", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId, kind, text: text.slice(0, 4000), ...extra }),
				signal: ctrl.signal
			});
			if (!response.ok) throw new Error("HTTP " + response.status);
			warned = false;
			const data = await response.json().catch(() => null);
			if (data && data.seedPrompt) {
				try {
					const llm = ctx.get("llm");
					if (llm) {
						const text = await dshGenerate(llm, "你是学习助手的知识点提取器。只按用户要求输出 JSON。", data.seedPrompt);
						await fetch(base + "/api/seed/import", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ text, meta: data.seedMeta })
						});
					}
				} catch (error) {
					log.warn?.("learning-assistant: seed fallback failed (%s)", String(error && error.message || error));
				}
			}
		} catch (error) {
			offlineUntil = Date.now() + RETRY_AFTER_MS;
			if (!warned) {
				warned = true;
				log.info?.("learning-assistant: service not reachable at %s (%s)", base, String(error && error.message || error));
			}
		} finally {
			clearTimeout(timer);
		}
	}

	/** 一轮里助手讲出判断就尽早匹配；同会话 5 分钟最多一次，避免打扰。 */
	function maybeProactive(sessionId, state, text, seq) {
		if (!text || text.length <= 80 || state.fired.why || state.fired.error) return;
		if (!VALUE.test(text)) return;
		if (Date.now() - (state.lastProactiveAt || 0) <= 5 * 60 * 1000) return;
		state.lastProactiveAt = Date.now();
		state.fired.proactive = true;
		void detect(sessionId, "proactive", text, { seq, turn: state.turn });
	}

	ctx.on("session/event", (session, event) => {
		if (!session || !event || !session.id) return;
		// 子代理的会话也旁听会太吵；只收顶层会话。
		if (session.header && session.header.origin === "subagent") return;
		let state = sessions.get(session.id);
		if (!state) {
			state = { turn: 0, fired: {}, lastAssistant: "", lastProactiveAt: 0 };
			sessions.set(session.id, state);
		}

		if (event.type === "turn/start") {
			state.turn = (event.data && event.data.turn) || 0;
			state.fired = {};
			state.lastAssistant = "";
			return;
		}

		if (event.type === "assistant/message") {
			const text = textOf(event.data && event.data.message && event.data.message.content);
			if (!text) return;
			const trimmed = text.slice(0, 4000);
			state.lastAssistant = trimmed;
			maybeProactive(session.id, state, trimmed, event.seq);
			return;
		}

		if (event.type === "turn/end") {
			maybeProactive(session.id, state, state.lastAssistant || "", event.seq);
			return;
		}

		if (event.type === "user/message") {
			const source = event.data && event.data.source;
			if (source && source.kind && source.kind !== "user") return;
			const text = textOf(event.data && event.data.content);
			if (!text || !WHY.test(text) || state.fired.why) return;
			state.fired.why = true;
			void detect(session.id, "why", text, { seq: event.seq, turn: state.turn });
			return;
		}

		if (event.type === "tool/result") {
			const message = event.data && event.data.message;
			if (!message || !message.isError || state.fired.error) return;
			const code = (event.data && event.data.error && event.data.error.code) || "";
			const text = textOf(message.content);
			if (OPERATIONAL.test(code + " " + text)) return;
			state.fired.error = true;
			void detect(session.id, "error", text || code || "error", { seq: event.seq, turn: state.turn });
		}
	});

	ctx.on("session/disposed", (session) => {
		if (session && session.id) sessions.delete(session.id);
	});

	const proxy = proxyHandler(() => base, () => {
		try { return ctx.get("llm"); } catch { return undefined; }
	});
	let dispose = () => {};
	let proxyAttached = false;
	const webServer = typeof ctx.get === "function" ? (() => {
		try { return ctx.get("webServer"); } catch { return undefined; }
	})() : undefined;
	if (webServer && typeof webServer.register === "function") {
		dispose = webServer.register({ kind: "prefix", path: PREFIX, handler: proxy });
		proxyAttached = true;
	} else if (typeof ctx.inject === "function") {
		try {
			ctx.inject(["webServer"], (child) => {
				if (disposed || proxyAttached) return;
				const ws = typeof child.get === "function" ? child.get("webServer") : undefined;
				if (!ws || typeof ws.register !== "function") return;
				dispose = ws.register({ kind: "prefix", path: PREFIX, handler: proxy });
				proxyAttached = true;
			});
		} catch {}
	}
	if (!proxyAttached) log.info?.("learning-assistant: webServer 服务不可用，插件继续启动；卡片站走直连回退");
	ctx.effect(() => () => {
		disposed = true;
		dispose();
		sessions.clear();
		process.off("exit", onExit);
		killOwned();
	});
	void ensureServices().then(() => {
		if (disposed) return;
		autoTimer = setTimeout(async () => {
			if (disposed) return;
			try {
				const result = await scanHistoryVia(base, { limit: 3, auto: true }, () => {
					try { return ctx.get("llm"); } catch { return undefined; }
				});
				if (result && result.generated) {
					log.info?.("learning-assistant: history catch-up generated %s card(s)", result.generated);
				} else if (result && result.error) {
					log.info?.("learning-assistant: history catch-up skipped (%s)", result.error);
				}
			} catch (error) {
				log.info?.("learning-assistant: history catch-up failed (%s)", String(error && error.message || error));
			}
		}, 8000);
	});
	ctx.effect(() => () => {
		if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
	});
}

export { apply, inject, name };
