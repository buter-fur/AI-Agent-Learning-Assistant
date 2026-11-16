/**
 * 学习小助手 · 浏览器半边。
 *
 * 一个 shell.overlay 小角标：默认只有一枚书签；有卡片时右上角出现数字。
 * 点击才展开卡片，不抢焦点、不出声、不弹系统通知；一次只显示一张。
 * 数据全部经同源代理 /learning-assistant/* 取，避免跨域与端口暴露。
 *
 * @module dsh-plugin-learning-assistant/client
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-learning-assistant",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;
		const { useEffect, useRef, useState, useCallback } = React;
		const NS = "learning-assistant";

		const zh = {
			"badge": "学习小助手",
			"title": "旁听",
			"online": "已连接",
			"offline": "未连接",
			"empty": "暂时没有要看的。继续做你的事，遇到值得记的东西我会出现。",
			"queue": "待看 {n} 张",
			"next": "取下一张",
			"got": "懂了",
			"nope": "没懂，换个说法",
			"easy": "太简单",
			"full": "看全文",
			"back": "返回",
			"close": "关闭",
			"saved": "记下了。",
			"kb": "知识库",
			"card": "卡片",
			"offlineHint": "学习小助手服务没起来，插件会自动拉起；若一直这样，看 学习小助手/app/data/auto-start.log。",
			"loadFail": "没取到全文，知识库服务可能没起。",
			"openSite": "卡片站",
			"station": "学习小助手 · 卡片站",
			"stationBoot": "卡片站启动中…",
			"stationClose": "关闭卡片站",
			"source": "来源",
			"rungG": "G{rung}",
			"score": "匹配 {score}",
			"one": "第 1 张",
			"historyTitle": "历史卡片",
			"historyEmpty": "还没有历史卡片。启用插件前的旧会话可以在这里补成卡片。",
			"historyScan": "扫描历史",
			"historyScanning": "正在补课…",
			"historyDone": "补了 {n} 张",
			"historyNone": "没有新的旧会话素材",
			"historySkipped": "12 小时内已经补过历史",
			"historyExpand": "展开",
			"historyCollapse": "收起",
			"historyBack": "返回列表",
			"historyProcessed": "已处理",
			"historyGenerated": "历史补卡",
			"historyAction": "处理：{action}",
			"historyNeedDsh": "需要 DSH 内置模型，但这次没接上。",
			"seed": "新知识点",
			"seedChip": "新知识点",
			"seedExpand": "展开细讲",
			"seedDrop": "先不用",
			"seedExpanding": "展开中…",
			"seedExpanded": "已展开成完整卡",
			"seedFailed": "展开失败，种子卡还留着",
			"settingsSummary": "模型与 API",
			"settingsTitle": "历史补课用哪个模型",
			"settingsIntro": "填了 API 就用 API；没填时用本地模型；两者都没有，直接调用 DSH 内置模型。本地模型没起时，灰区判定会用 API 做小请求。",
			"settingsBase": "API 地址",
			"settingsModel": "模型",
			"settingsKey": "API Key",
			"settingsKeyHint": "留空表示不修改；没有 key 时自动走本地模型或 DSH。",
			"settingsSave": "保存",
			"settingsTest": "测试连接",
			"settingsSaved": "已保存",
			"settingsLocal": "本地模型",
			"settingsLocalUp": "在跑 · {model}",
			"settingsLocalDown": "没起",
			"settingsApiSet": "已配置 · {key}",
			"settingsApiUnset": "未配置",
			"priorityLabel": "模型优先级",
			"priorityHint": "三档各用一次；排在前面的先试，不可用才往后走。",
			"priorityApiLocalDsh": "API → 本地模型 → DSH",
			"priorityApiDshLocal": "API → DSH → 本地模型",
			"priorityLocalApiDsh": "本地模型 → API → DSH",
			"priorityLocalDshApi": "本地模型 → DSH → API",
			"priorityDshApiLocal": "DSH → API → 本地模型",
			"priorityDshLocalApi": "DSH → 本地模型 → API",
			"lookbackLabel": "历史回溯方式",
			"lookbackHint": "默认每个旧会话取最近 8 轮；按天则只取最近 N 天内。",
			"lookbackTurns": "最近几轮对话",
			"lookbackDays": "最近几天",
			"lookbackTurnsOption": "按对话轮数",
			"lookbackDaysOption": "按天数",
			"sessionScanLoading": "本会话扫描…",
			"sessionScanOn": "关闭本会话扫描",
			"sessionScanOff": "开启本会话扫描",
			"sessionScanFailed": "本会话扫描状态读取失败"
		};

		const en = {
			"badge": "Learning assistant",
			"title": "Listening",
			"online": "Connected",
			"offline": "Offline",
			"empty": "Nothing to review yet. Keep working; I will show up when something is worth keeping.",
			"queue": "{n} waiting",
			"next": "Next card",
			"got": "Got it",
			"nope": "Not clear",
			"easy": "Too easy",
			"full": "Read more",
			"back": "Back",
			"close": "Close",
			"saved": "Saved.",
			"kb": "Knowledge base",
			"card": "Card",
			"offlineHint": "The learning assistant service is not up yet; the plugin will start it automatically. If it stays offline, check 学习小助手/app/data/auto-start.log.",
			"loadFail": "Could not load the full text; the knowledge service may be down.",
			"openSite": "Card station",
			"station": "Learning assistant · Card station",
			"stationBoot": "Starting the card station…",
			"stationClose": "Close card station",
			"source": "Source",
			"rungG": "G{rung}",
			"score": "match {score}",
			"one": "1 card",
			"historyTitle": "History cards",
			"historyEmpty": "No history cards yet. Older conversations can be turned into cards here.",
			"historyScan": "Scan history",
			"historyScanning": "Catching up…",
			"historyDone": "{n} card(s) added",
			"historyNone": "No new material in older conversations",
			"historySkipped": "History was already scanned within 12 hours",
			"historyExpand": "Expand",
			"historyCollapse": "Collapse",
			"historyBack": "Back to list",
			"historyProcessed": "Processed",
			"historyGenerated": "From history",
			"historyAction": "Action: {action}",
			"historyNeedDsh": "The DSH built-in model was needed but unavailable.",
			"seed": "New knowledge",
			"seedChip": "New knowledge",
			"seedExpand": "Expand",
			"seedDrop": "Not now",
			"seedExpanding": "Expanding…",
			"seedExpanded": "Expanded into a full card",
			"seedFailed": "Expansion failed; the seed is still here",
			"settingsSummary": "Model & API",
			"settingsTitle": "Model for history catch-up",
			"settingsIntro": "The API below is used when configured; otherwise the local model; if neither is available, the DSH built-in model is used. Without a local model, gray-zone checks use a small API request.",
			"settingsBase": "API base URL",
			"settingsModel": "Model",
			"settingsKey": "API key",
			"settingsKeyHint": "Leave blank to keep the saved key. Without a key, local or DSH is used.",
			"settingsSave": "Save",
			"settingsTest": "Test connection",
			"settingsSaved": "Saved",
			"settingsLocal": "Local model",
			"settingsLocalUp": "Running · {model}",
			"settingsLocalDown": "Not running",
			"settingsApiSet": "Configured · {key}",
			"settingsApiUnset": "Not configured",
			"priorityLabel": "Model priority",
			"priorityHint": "Each tier is used once; earlier tiers are tried first.",
			"priorityApiLocalDsh": "API → local → DSH",
			"priorityApiDshLocal": "API → DSH → local",
			"priorityLocalApiDsh": "Local → API → DSH",
			"priorityLocalDshApi": "Local → DSH → API",
			"priorityDshApiLocal": "DSH → API → local",
			"priorityDshLocalApi": "DSH → local → API",
			"lookbackLabel": "History lookback",
			"lookbackHint": "Default: the last 8 turns of each older conversation; by days, only the last N days.",
			"lookbackTurns": "Recent turns",
			"lookbackDays": "Recent days",
			"lookbackTurnsOption": "By turns",
			"lookbackDaysOption": "By days",
			"sessionScanLoading": "Session scanning…",
			"sessionScanOn": "Turn off scanning for this session",
			"sessionScanOff": "Turn on scanning for this session",
			"sessionScanFailed": "Could not read scanning state"
		};

		const LANE = { mechanism: "机制", syntax: "语法", algorithm: "算法", judgment: "判断" };
		const RUNG = ["认得", "看懂", "讲清", "判断", "迁移"];

		const CSS = `
.dshla-root{position:fixed;right:20px;bottom:84px;z-index:2147483647;pointer-events:none;font-family:var(--dsw-font-family,-apple-system,"PingFang SC",sans-serif);font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary,#1f2328)}
.dshla-badge{pointer-events:auto;position:relative;width:46px;height:46px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1,#e3e3e3);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 6px 18px rgba(0,0,0,.12);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;color:var(--dsw-alias-label-secondary,#555);transition:transform .12s ease,box-shadow .12s ease}
.dshla-badge:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(0,0,0,.16)}
.dshla-badge.is-off{opacity:.55}
.dshla-icon{width:23px;height:23px;display:block;color:var(--dsw-alias-label-primary,#1f2328)}
.dshla-count{position:absolute;top:-5px;right:-4px;min-width:17px;height:17px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3b6cff);color:#fff;font-size:10px;line-height:17px;text-align:center;font-weight:600}
.dshla-panel{pointer-events:auto;position:absolute;right:0;bottom:58px;width:min(370px,calc(100vw - 32px));max-height:72vh;overflow:auto;border:1px solid var(--dsw-alias-border-l1,#e3e3e3);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 18px 46px rgba(0,0,0,.22);padding:14px 15px 12px}
.dshla-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.dshla-h{font-size:15px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary,#1f2328)}
.dshla-sub{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dshla-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3b6cff);display:inline-block}
.dshla-dot.is-off{background:var(--dsw-alias-label-tertiary,#aaa)}
.dshla-close{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:18px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px}
.dshla-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2328)}
.dshla-body{margin-top:12px}
.dshla-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.dshla-chip{font-size:10.5px;color:var(--dsw-alias-label-secondary,#555);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));border-radius:999px;padding:1px 7px;line-height:1.8}
.dshla-title{font-size:15px;font-weight:600;margin:0 0 4px;color:var(--dsw-alias-label-primary,#1f2328);line-height:1.5}
.dshla-text{margin:0 0 8px;color:var(--dsw-alias-label-secondary,#555);font-size:12.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word}
.dshla-quote{margin:8px 0;padding:8px 10px;border-left:2px solid var(--dsw-alias-border-l2,#ddd);color:var(--dsw-alias-label-secondary,#555);font-size:12px;line-height:1.7;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03));border-radius:0 6px 6px 0;white-space:pre-wrap}
.dshla-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
.dshla-btn{border:1px solid var(--dsw-alias-border-l1,#e3e3e3);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);border-radius:8px;padding:5px 10px;font-size:12px;line-height:1.6;cursor:pointer;font-family:inherit}
.dshla-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dshla-btn.primary{background:var(--dsw-alias-state-business-primary,#3b6cff);border-color:transparent;color:#fff}
.dshla-btn.primary:hover{opacity:.9}
.dshla-btn:disabled{opacity:.5;cursor:default}
.dshla-empty{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12.5px;line-height:1.8;margin:6px 0}
.dshla-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1,#eee);font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dshla-link{color:var(--dsw-alias-state-business-primary,#3b6cff);text-decoration:none;cursor:pointer;border:0;background:none;padding:0;font:inherit}
.dshla-link:hover{text-decoration:underline}
.dshla-flash{color:var(--dsw-alias-label-secondary,#555);font-size:11.5px;margin-left:auto}
.dshla-src{word-break:break-all;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-top:6px}
.dshla-station{position:fixed;inset:0;z-index:2147483647;background:rgba(15,18,24,.45);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:2vh 2vw;pointer-events:auto}
.dshla-station-box{position:relative;width:min(1240px,96vw);height:min(880px,94vh);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l1,#e3e3e3);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 28px 80px rgba(0,0,0,.36)}
.dshla-station-bar{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 13px;border-bottom:1px solid var(--dsw-alias-border-l1,#eee);background:var(--dsw-alias-bg-layer-1,#fff);flex:0 0 auto}
.dshla-station-close{display:inline-flex;align-items:center;gap:4px;width:auto;padding:4px 9px;border:1px solid var(--dsw-alias-border-l1,#e3e3e3);background:transparent;color:var(--dsw-alias-label-secondary,#555);font-size:12px;line-height:1.5;border-radius:7px;cursor:pointer;font-family:inherit}
.dshla-station-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1f2328)}
.dshla-station-close .x{font-size:16px;line-height:1}
.dshla-station-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.dshla-station-actions{display:flex;align-items:center;gap:8px}
.dshla-station-boot{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dshla-frame{display:block;flex:1;width:100%;border:0;background:#f7f4ee}
.dshla-station-load{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:13px;background:#f7f4ee}
.dshla-station-load.is-overlay{position:absolute;inset:41px 0 0;z-index:2;background:rgba(247,244,238,.88);backdrop-filter:blur(3px)}
.dshla-history{margin-top:12px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1,#eee)}
.dshla-history-head{display:flex;align-items:center;gap:7px;width:100%;padding:2px 0;border:0;background:transparent;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary,#1f2328);text-align:left}
.dshla-history-title{font-size:12.5px;font-weight:600}
.dshla-history-count{font-size:10px;line-height:1.7;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#555)}
.dshla-history-toggle{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}
.dshla-history-body{margin-top:6px;max-height:210px;overflow:auto}
.dshla-history-item{display:block;width:100%;padding:7px 0;border:0;border-bottom:1px dashed var(--dsw-alias-border-l1,#eee);background:transparent;text-align:left;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary,#1f2328)}
.dshla-history-item:last-child{border-bottom:0}
.dshla-history-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dshla-history-item-title{display:block;font-size:12.5px;font-weight:600;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshla-history-item-meta{display:block;margin-top:2px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshla-history-detail{padding:2px 0 4px}
.dshla-history-detail-title{font-size:14px;font-weight:600;line-height:1.5;margin:0 0 4px}
.dshla-history-detail-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-bottom:7px}
.dshla-settings{padding:2px 0 8px;max-width:560px}
.dshla-settings-title{font-size:14px;font-weight:600;margin:0 0 4px}
.dshla-settings-intro{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#555);margin:0 0 12px}
.dshla-field{margin-bottom:10px}
.dshla-field label{display:block;font-size:12px;font-weight:600;margin-bottom:4px}
.dshla-field input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);padding:6px 8px;font:inherit;font-size:12.5px}
.dshla-field input:focus,.dshla-field select:focus{outline:2px solid var(--dsw-alias-state-business-primary,#3b6cff);outline-offset:-1px}
.dshla-field select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);padding:6px 8px;font:inherit;font-size:12.5px}
.dshla-field-hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-top:3px;line-height:1.6}
.dshla-settings-status{font-size:11px;color:var(--dsw-alias-label-secondary,#555);margin-left:8px}
.dshla-settings-local{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin-top:10px;line-height:1.7}
.dshla-settings-sep{height:1px;background:var(--dsw-alias-border-l1,#eee);margin:12px 0}
.dshla-menu-item{display:block;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}
.dshla-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dshla-menu-item:disabled{opacity:.55;cursor:default}
`;

		/** 桌面版页面可能跑在 dsh-app:// 自定义协议下，同源相对路径到不了 HTTP 宿主；
		 * 这里从 DSH transport / boot 图里取真正的 HTTP origin，再拼同源代理前缀。 */
		function httpOrigin() {
			try {
				const transport = globalThis.__DSH_TRANSPORT__;
				if (transport && typeof transport.streamBaseUrl === "string") {
					const u = new URL(transport.streamBaseUrl);
					if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
				}
			} catch (_e) {}
			try {
				const boot = globalThis.__DSH_BOOT__;
				const entries = boot && Array.isArray(boot.entries) ? boot.entries : [];
				for (const entry of entries) {
					if (!entry || typeof entry.url !== "string") continue;
					try {
						const u = new URL(entry.url, location.href);
						if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
					} catch (_e) {}
				}
			} catch (_e) {}
			try {
				if (location.protocol === "http:" || location.protocol === "https:") return location.origin;
			} catch (_e) {}
			return "";
		}

		const HTTP_ORIGIN = httpOrigin();
		const DIRECT_BASE = "http://127.0.0.1:4780";
		function proxyURL(path) { return HTTP_ORIGIN + "/learning-assistant" + path; }
		function directURL(path) { return DIRECT_BASE + path; }

		/** DSH 现在是深色还是浅色；卡片站首次打开时按它选主题。 */
		function isDarkTheme() {
			try {
				if (document.documentElement.hasAttribute("data-ds-dark-theme")) return true;
				if (document.body && document.body.hasAttribute("data-ds-dark-theme")) return true;
				if (document.documentElement.dataset.theme === "dark") return true;
				if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return true;
			} catch (_e) {}
			return false;
		}

		/** 同源代理优先；老版本 DSH 没有 webServer 服务时，回退到 4780 直连。 */
		async function requestJSON(path, options) {
			const targets = [proxyURL(path)];
			if (DIRECT_BASE && directURL(path) !== targets[0]) targets.push(directURL(path));
			let last = null;
			for (const url of targets) {
				try {
					const response = await fetch(url, { cache: "no-store", ...options });
					if (!response.ok) { last = new Error("HTTP " + response.status); continue; }
					return response.json();
				} catch (error) {
					last = error;
				}
			}
			throw last || new Error("offline");
		}

		function getJSON(path) { return requestJSON(path, {}); }

		function postJSON(path, body) {
			return requestJSON(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body || {})
			});
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }));
			const t = ctx.locale.bind(NS);

			/** 右键会话标题/「…」菜单项：只切换这个会话的实时旁听与历史补课。 */
			function SessionScanMenuItem(props) {
				const tt = props.t || t;
				const [, setMenuOpen] = props.useMenuOpenState();
				const [enabled, setEnabled] = useState(true);
				const [status, setStatus] = useState("loading");
				const [busy, setBusy] = useState(false);

				useEffect(() => {
					let alive = true;
					getJSON("/api/session/scan?sessionId=" + encodeURIComponent(props.sessionId))
						.then((data) => {
							if (!alive) return;
							setEnabled(data.enabled !== false);
							setStatus("ready");
						})
						.catch(() => { if (alive) setStatus("error"); });
					return () => { alive = false; };
				}, [props.sessionId]);

				const toggle = async () => {
					if (busy) return;
					setBusy(true);
					try {
						const data = await postJSON("/api/session/scan", { sessionId: props.sessionId, enabled: !enabled });
						setEnabled(data.enabled !== false);
						setStatus("ready");
						setMenuOpen(false);
					} catch (_error) {
						setStatus("error");
					} finally {
						setBusy(false);
					}
				};

				const label = status === "loading"
					? tt("sessionScanLoading")
					: status === "error"
						? tt("sessionScanFailed")
						: enabled ? tt("sessionScanOn") : tt("sessionScanOff");
				return h("button", {
					type: "button", role: "menuitem", className: "dshla-menu-item",
					disabled: busy || status === "loading", onClick: toggle
				}, label);
			}

			/** 插件页里的配置表单：历史补课用本地模型、这里填的 API，还是 DSH 内置模型。 */
			function SettingsPage(props) {
				const tt = props.t || t;
				const [state, setState] = useState(null);
				const [baseURL, setBaseURL] = useState("");
				const [model, setModel] = useState("");
				const [apiKey, setApiKey] = useState("");
				const [msg, setMsg] = useState("");
				const [busy, setBusy] = useState(false);
				const [priority, setPriority] = useState("api,local,dsh");
				const [lookbackMode, setLookbackMode] = useState("turns");
				const [turns, setTurns] = useState("8");
				const [days, setDays] = useState("7");

				useEffect(() => {
					let alive = true;
					getJSON("/api/settings/llm").then((data) => {
						if (!alive) return;
						setState(data);
						setBaseURL(data.baseURL || "");
						setModel(data.model || "");
						if (Array.isArray(data.historyPriority)) setPriority(data.historyPriority.join(","));
						if (data.historyLookback) {
							setLookbackMode(data.historyLookback.mode === "days" ? "days" : "turns");
							setTurns(String(data.historyLookback.turns || 8));
							setDays(String(data.historyLookback.days || 7));
						}
					}).catch(() => { if (alive) setMsg(tt("offline")); });
					return () => { alive = false; };
				}, []);

				if (props.view === "summary") return tt("settingsSummary");

				const save = async () => {
					if (busy) return;
					setBusy(true); setMsg("");
					try {
						const body = {
							baseURL, model,
							historyPriority: priority.split(","),
							historyLookback: { mode: lookbackMode, turns: Number(turns) || 8, days: Number(days) || 7 }
						};
						if (apiKey.trim()) body.apiKey = apiKey.trim();
						const data = await postJSON("/api/settings/llm", body);
						setState(data);
						setApiKey("");
						setMsg(tt("settingsSaved"));
					} catch (error) {
						setMsg(String(error.message || error));
					} finally { setBusy(false); }
				};

				const test = async () => {
					if (busy) return;
					setBusy(true); setMsg("");
					try {
						const data = await postJSON("/api/settings/llm/test", {});
						setMsg(data.ok ? ("✅ " + data.ms + "ms · " + data.model) : data.error);
					} catch (error) {
						setMsg(String(error.message || error));
					} finally { setBusy(false); }
				};

				const local = state && state.local;
				const field = (label, value, setter, opts = {}) => h("div", { className: "dshla-field" }, [
					h("label", { key: "l" }, label),
					h("input", {
						key: "i", value: value, type: opts.type || "text",
						placeholder: opts.placeholder || "", autoComplete: "off",
						onChange: (event) => setter(event.target.value)
					}),
					opts.hint ? h("div", { className: "dshla-field-hint", key: "h" }, opts.hint) : null
				]);
				const selectField = (label, value, setter, options, hint) => h("div", { className: "dshla-field" }, [
					h("label", { key: "l" }, label),
					h("select", {
						key: "s", value: value,
						onChange: (event) => setter(event.target.value)
					}, options.map(([key, text]) => h("option", { key: key, value: key }, text))),
					hint ? h("div", { className: "dshla-field-hint", key: "h" }, hint) : null
				]);
				const priorityOptions = [
					["api,local,dsh", tt("priorityApiLocalDsh")],
					["api,dsh,local", tt("priorityApiDshLocal")],
					["local,api,dsh", tt("priorityLocalApiDsh")],
					["local,dsh,api", tt("priorityLocalDshApi")],
					["dsh,api,local", tt("priorityDshApiLocal")],
					["dsh,local,api", tt("priorityDshLocalApi")]
				];

				return h("div", { className: "dshla-settings" }, [
					h("style", { key: "css" }, CSS),
					h("h3", { className: "dshla-settings-title", key: "t" }, tt("settingsTitle")),
					h("p", { className: "dshla-settings-intro", key: "i" }, tt("settingsIntro")),
					field(tt("settingsBase"), baseURL, setBaseURL),
					field(tt("settingsModel"), model, setModel),
					field(tt("settingsKey"), apiKey, setApiKey, {
						type: "password",
						placeholder: state && state.hasKey ? state.maskedKey : "sk-…",
						hint: tt("settingsKeyHint")
					}),
					selectField(tt("priorityLabel"), priority, setPriority, priorityOptions, tt("priorityHint")),
					selectField(tt("lookbackLabel"), lookbackMode, setLookbackMode, [
						["turns", tt("lookbackTurnsOption")],
						["days", tt("lookbackDaysOption")]
					], tt("lookbackHint")),
					lookbackMode === "turns"
						? field(tt("lookbackTurns"), turns, setTurns, { type: "number" })
						: field(tt("lookbackDays"), days, setDays, { type: "number" }),
					h("div", { className: "dshla-actions", key: "a" }, [
						h("button", { className: "dshla-btn primary", type: "button", disabled: busy, onClick: save, key: "s" }, tt("settingsSave")),
						h("button", { className: "dshla-btn", type: "button", disabled: busy, onClick: test, key: "t" }, tt("settingsTest")),
						msg ? h("span", { className: "dshla-settings-status", key: "m" }, msg) : null
					]),
					h("div", { className: "dshla-settings-sep", key: "sep" }),
					h("div", { className: "dshla-settings-local", key: "l" }, [
						tt("settingsLocal") + "：" + (local && local.up
							? tt("settingsLocalUp", { model: local.model || "?" })
							: tt("settingsLocalDown")),
						h("br", { key: "br" }),
						state && state.hasKey ? tt("settingsApiSet", { key: state.maskedKey }) : tt("settingsApiUnset")
					])
				]);
			}

			function Widget() {
				const [item, setItem] = useState(null);
				const [queue, setQueue] = useState(0);
				const [online, setOnline] = useState(true);
				const [open, setOpen] = useState(false);
				const [busy, setBusy] = useState(false);
				const [flash, setFlash] = useState("");
				const [kbText, setKbText] = useState(null);
				const [station, setStationOpen] = useState(false);
				const [history, setHistory] = useState([]);
				const [historyOpen, setHistoryOpen] = useState(false);
				const [historyBusy, setHistoryBusy] = useState(false);
				const [historyMsg, setHistoryMsg] = useState("");
				const [historyDetail, setHistoryDetail] = useState(null);
				const timer = useRef(null);
				const alive = useRef(true);
				const failures = useRef(0);
				const historyBodyRef = useRef(null);

				const refreshHistory = useCallback(async () => {
					try {
						const data = await getJSON("/api/history/list?limit=40");
						if (alive.current) setHistory((data.items || []));
					} catch (_error) {
						/* 老版本服务没有这个接口时静默；不影响实时旁听 */
					}
				}, []);

				const refresh = useCallback(async () => {
					if (typeof document !== "undefined" && document.hidden) return;
					try {
						const [pending, waiting] = await Promise.all([
							getJSON("/api/whisper/pending"),
							getJSON("/api/whisper/queue")
						]);
						if (!alive.current) return;
						failures.current = 0;
						setOnline(true);
						setItem(pending.item || null);
						setQueue(((waiting.items || []).length));
					} catch (_error) {
						// 单次抖动不要把 iframe 卸掉；连续失败两次才标离线。
						if (!alive.current) return;
						failures.current += 1;
						if (failures.current >= 2) setOnline(false);
					}
				}, []);

				useEffect(() => {
					alive.current = true;
					void refresh();
					void refreshHistory();
					timer.current = window.setInterval(() => { void refresh(); }, 4000);
					const onVisible = () => { if (!document.hidden) void refresh(); };
					document.addEventListener("visibilitychange", onVisible);
					return () => {
						alive.current = false;
						if (timer.current) window.clearInterval(timer.current);
						document.removeEventListener("visibilitychange", onVisible);
					};
				}, [refresh, refreshHistory]);

				useEffect(() => { setKbText(null); }, [item]);

				useEffect(() => {
					if (historyBodyRef.current) historyBodyRef.current.scrollTop = 0;
				}, [historyDetail, historyOpen]);

				useEffect(() => {
					if (!open && !station) return;
					const onKey = (event) => {
						if (event.key !== "Escape") return;
						setOpen(false);
						setStationOpen(false);
					};
					document.addEventListener("keydown", onKey, true);
					return () => document.removeEventListener("keydown", onKey, true);
				}, [open, station]);

				const total = (item ? 1 : 0) + queue;
				const isKb = !!(item && item.card && item.card.shape === "kb");
				const isSeed = !!(item && item.card && item.card.shape === "seed");

				const act = async (action) => {
					if (!item || busy) return;
					setBusy(true);
					try {
						await postJSON("/api/whisper/ack", { id: item.id, action });
						setItem(null);
						setKbText(null);
						setFlash(t("saved"));
						window.setTimeout(() => setFlash(""), 1500);
					} catch (_error) {
						setFlash(t("offline"));
					} finally {
						setBusy(false);
						void refresh();
						void refreshHistory();
					}
				};

				const scanHistoryNow = async () => {
					if (historyBusy) return;
					setHistoryBusy(true);
					setHistoryMsg(t("historyScanning"));
					try {
						const data = await postJSON("/api/history/scan", { limit: 3 });
						if (data.skipped) setHistoryMsg(t("historySkipped"));
						else if (data.needsDsh) setHistoryMsg(t("historyNeedDsh"));
						else if (data.generated) setHistoryMsg(t("historyDone", { n: data.generated }));
						else setHistoryMsg(data.message || t("historyNone"));
						await refreshHistory();
						setHistoryOpen(true);
					} catch (error) {
						setHistoryMsg(t("offline"));
					} finally {
						setHistoryBusy(false);
					}
				};

				const takeNext = async () => {
					if (busy) return;
					setBusy(true);
					try {
						const data = await postJSON("/api/whisper/next", {});
						setItem(data.item || null);
						setQueue((n) => Math.max(0, n - (data.item ? 1 : 0)));
					} catch (_error) {
						setOnline(false);
					} finally {
						setBusy(false);
						void refreshHistory();
					}
				};

				const openStation = () => {
					setOpen(false);
					setStationOpen(true);
					void refresh();
				};

				const closeStation = (event) => {
					if (event) {
						event.preventDefault();
						event.stopPropagation();
					}
					setStationOpen(false);
				};

				const expandSeed = async () => {
					if (!item || !isSeed || busy) return;
					setBusy(true);
					try {
						const data = await postJSON("/api/seed/expand", { seedId: item.card.id });
						if (!data || !data.ok) throw new Error((data && data.error) || t("seedFailed"));
						setItem(data.item || null);
						setKbText(null);
						setFlash(t("seedExpanded"));
					} catch (error) {
						setFlash(String(error.message || error));
					} finally {
						setBusy(false);
						void refresh();
					}
				};

				const loadFull = async () => {
					if (!item || !item.card) return;
					const id = item.card.kbId || item.card.id;
					setBusy(true);
					try {
						const data = await getJSON("/api/kb/item?id=" + encodeURIComponent(id));
						setKbText(data.document || data.text || t("loadFail"));
					} catch (_error) {
						setKbText(t("loadFail"));
					} finally {
						setBusy(false);
					}
				};

				const head = item ? (
					h("div", { className: "dshla-head" }, [
						h("div", { key: "t" }, [
							h("h3", { className: "dshla-h", key: "h" }, (item.card && item.card.title) || t("title")),
							h("div", { className: "dshla-sub", key: "s" }, [
								h("span", { className: "dshla-dot" + (online ? "" : " is-off"), key: "d" }),
								h("span", { key: "o" }, online ? t("online") : t("offline")),
								h("span", { key: "l" }, "· " + (isKb ? t("kb") : isSeed ? t("seed") : t("card")))
							])
						]),
						h("button", {
							className: "dshla-close", type: "button", title: t("close"),
							onClick: () => setOpen(false)
						}, "×")
					])
				) : h("div", { className: "dshla-head" }, [
					h("div", { key: "t" }, [
						h("h3", { className: "dshla-h", key: "h" }, t("title")),
						h("div", { className: "dshla-sub", key: "s" }, [
							h("span", { className: "dshla-dot" + (online ? "" : " is-off"), key: "d" }),
							h("span", { key: "o" }, online ? t("online") : t("offline"))
						])
					]),
					h("button", {
						className: "dshla-close", type: "button", title: t("close"),
						onClick: () => setOpen(false)
					}, "×")
				]);

				let body;
				if (!online) {
					body = h("div", { className: "dshla-body" }, [
						h("p", { className: "dshla-empty", key: "e" }, t("offlineHint"))
					]);
				} else if (!item) {
					body = h("div", { className: "dshla-body" }, [
						h("p", { className: "dshla-empty", key: "e" }, queue > 0 ? t("queue", { n: queue }) : t("empty")),
						queue > 0 ? h("div", { className: "dshla-actions", key: "a" }, [
							h("button", { className: "dshla-btn primary", type: "button", disabled: busy || !online, onClick: takeNext }, t("next"))
						]) : null
					]);
				} else if (isSeed) {
					const card = item.card || {};
					const lane = LANE[card.lane] || card.lane || "";
					body = h("div", { className: "dshla-body" }, [
						h("div", { className: "dshla-meta", key: "m" }, [
							h("span", { className: "dshla-chip", key: "s" }, t("seedChip")),
							lane ? h("span", { className: "dshla-chip", key: "l" }, lane) : null
						]),
						card.scene ? h("p", { className: "dshla-text", key: "sc" }, card.scene) : null,
						card.takeaway ? h("div", { className: "dshla-quote", key: "tk" }, card.takeaway) : null,
						h("div", { className: "dshla-actions", key: "ac" }, [
							h("button", { className: "dshla-btn primary", type: "button", disabled: busy, onClick: expandSeed, key: "e" }, busy ? t("seedExpanding") : t("seedExpand")),
							h("button", { className: "dshla-btn", type: "button", disabled: busy, onClick: () => act("drop"), key: "d" }, t("seedDrop"))
						])
					]);
				} else {
					const card = item.card || {};
					const lane = LANE[card.lane] || card.lane || "";
					const rung = typeof card.rung === "number" ? card.rung : 0;
					body = h("div", { className: "dshla-body" }, [
						h("div", { className: "dshla-meta", key: "m" }, [
							lane ? h("span", { className: "dshla-chip", key: "l" }, lane) : null,
							!isKb && typeof card.rung === "number" ? h("span", { className: "dshla-chip", key: "r" }, t("rungG", { rung: rung }) + " · " + (RUNG[rung] || "") ) : null,
							item.reason ? h("span", { className: "dshla-chip", key: "s" }, t("score", { score: Number(item.score || 0).toFixed(2) })) : null
						]),
						card.scene ? h("p", { className: "dshla-text", key: "sc" }, card.scene) : null,
						card.summary ? h("p", { className: "dshla-text", key: "su" }, card.summary) : null,
						card.takeaway ? h("div", { className: "dshla-quote", key: "tk" }, card.takeaway) : null,
						card.explain && !isKb ? h("p", { className: "dshla-text", key: "ex" }, card.explain) : null,
						kbText ? h("p", { className: "dshla-text", key: "kb" }, kbText) : null,
						isKb && !kbText ? h("div", { className: "dshla-actions", key: "fa" }, [
							h("button", { className: "dshla-btn", type: "button", disabled: busy, onClick: loadFull }, t("full"))
						]) : null,
						card.source && card.source.project ? h("div", { className: "dshla-src", key: "src" }, t("source") + " · " + card.source.project) : null,
						h("div", { className: "dshla-actions", key: "ac" }, isKb
							? [
								h("button", { className: "dshla-btn primary", type: "button", disabled: busy, onClick: () => act("got"), key: "k" }, t("got"))
							]
							: [
								h("button", { className: "dshla-btn primary", type: "button", disabled: busy, onClick: () => act("got"), key: "g" }, t("got")),
								h("button", { className: "dshla-btn", type: "button", disabled: busy, onClick: () => act("nope"), key: "n" }, t("nope")),
								h("button", { className: "dshla-btn", type: "button", disabled: busy, onClick: () => act("too-easy"), key: "e" }, t("easy"))
							])
					]);
				}


				const ACTION = { got: "懂了", nope: "没懂", "too-easy": "太简单", next: "取下一张" };
				const fmtWhen = (ts) => {
					try {
						return new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
					} catch (_e) { return ""; }
				};
				const historySection = h("div", { className: "dshla-history" }, [
					h("button", {
						className: "dshla-history-head", type: "button",
						"aria-expanded": historyOpen ? "true" : "false",
						onClick: () => { setHistoryOpen((v) => !v); if (!historyOpen) void refreshHistory(); }
					}, [
						h("span", { className: "dshla-history-title", key: "t" }, t("historyTitle")),
						h("span", { className: "dshla-history-count", key: "c" }, String(history.length)),
						h("span", { className: "dshla-history-toggle", key: "g" }, historyOpen ? t("historyCollapse") : t("historyExpand"))
					]),
					historyOpen ? h("div", { className: "dshla-history-body", ref: historyBodyRef }, [
						historyDetail ? h("div", { className: "dshla-history-detail", key: "d" }, [
							h("button", {
								className: "dshla-link", type: "button",
								onClick: () => setHistoryDetail(null)
							}, "← " + t("historyBack")),
							h("div", { className: "dshla-history-detail-title" }, historyDetail.title || "未命名"),
							h("div", { className: "dshla-history-detail-meta" }, [
								historyDetail.kind === "processed" ? t("historyProcessed") : t("historyGenerated"),
								historyDetail.lane ? (LANE[historyDetail.lane] || historyDetail.lane) : "",
								historyDetail.action ? (ACTION[historyDetail.action] || historyDetail.action) : "",
								fmtWhen(historyDetail.createdAt)
							].filter(Boolean).join(" · ")),
							historyDetail.card && historyDetail.card.scene ? h("p", { className: "dshla-text" }, historyDetail.card.scene) : null,
							historyDetail.summary ? h("div", { className: "dshla-quote" }, historyDetail.summary) : null,
							historyDetail.card && historyDetail.card.explain ? h("p", { className: "dshla-text" }, historyDetail.card.explain) : null
						]) : (
							history.length ? history.map((x) => h("button", {
								key: x.id, className: "dshla-history-item", type: "button",
								onClick: () => setHistoryDetail(x)
							}, [
								h("span", { className: "dshla-history-item-title", key: "t" }, x.title || "未命名"),
								h("span", { className: "dshla-history-item-meta", key: "m" }, [
									x.kind === "processed" ? t("historyProcessed") : t("historyGenerated"),
									x.lane ? (LANE[x.lane] || x.lane) : "",
									x.action ? (ACTION[x.action] || x.action) : "",
									fmtWhen(x.createdAt)
								].filter(Boolean).join(" · "))
							])) : h("p", { className: "dshla-empty", key: "e" }, t("historyEmpty"))
						),
						h("div", { className: "dshla-actions", key: "a" }, [
							h("button", {
								className: "dshla-btn", type: "button",
								disabled: historyBusy || !online,
								onClick: scanHistoryNow
							}, historyBusy ? t("historyScanning") : t("historyScan")),
							historyMsg ? h("span", { className: "dshla-flash", key: "m" }, historyMsg) : null
						])
					]) : null
				]);

				const foot = h("div", { className: "dshla-foot" }, [
					h("span", { key: "q" }, item ? (queue > 0 ? t("queue", { n: queue }) : t("one")) : (queue > 0 ? t("queue", { n: queue }) : "")),
					flash ? h("span", { className: "dshla-flash", key: "f" }, flash) : null,
					h("button", {
						className: "dshla-link", key: "o", type: "button", onClick: openStation
					}, t("openSite"))
				]);

				return h("div", { className: "dshla-root" }, [
					h("style", { key: "css" }, CSS),
					h("button", {
						key: "badge",
						className: "dshla-badge" + (item ? " has" : "") + (online ? "" : " is-off"),
						type: "button",
						title: t("badge"),
						"aria-label": t("badge"),
						"aria-expanded": open ? "true" : "false",
						onClick: () => { setOpen((v) => !v); void refresh(); }
					}, [
						h("svg", {
							key: "i", className: "dshla-icon", viewBox: "0 0 24 24", fill: "none",
							stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round",
							strokeLinejoin: "round", "aria-hidden": "true"
						}, [
							h("path", { key: "a", d: "M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5z" }),
							h("path", { key: "b", d: "M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5A2.5 2.5 0 0 1 20 21.5z" })
						]),
						total > 0 ? h("span", { key: "c", className: "dshla-count" }, String(total)) : null
					]),
					open ? h("div", { key: "panel", className: "dshla-panel", role: "dialog", "aria-label": t("title") }, [head, body, historySection, foot]) : null,
					station ? h("div", {
						key: "station", className: "dshla-station",
						onClick: () => setStationOpen(false)
					}, [
						h("div", { className: "dshla-station-box", onClick: (event) => event.stopPropagation() }, [
							h("div", { className: "dshla-station-bar" }, [
								h("span", { className: "dshla-station-title", key: "t" }, t("station")),
								h("div", { className: "dshla-station-actions", key: "a" }, [
									online ? null : h("span", { className: "dshla-station-boot", key: "b" }, t("stationBoot")),
									h("button", {
										className: "dshla-station-close", type: "button", title: t("stationClose"),
										"aria-label": t("stationClose"), "data-station-close": "1",
										onClick: closeStation, key: "x"
									}, [
										h("span", { className: "x", key: "x", "aria-hidden": "true" }, "×"),
										h("span", { key: "l" }, t("close"))
									])
								])
							]),
							h("iframe", { className: "dshla-frame", src: proxyURL("/") + "?theme=" + (isDarkTheme() ? "dark" : "light"), title: t("station"), key: "f" }),
							online ? null : h("div", { className: "dshla-station-load is-overlay", key: "l" }, t("stationBoot"))
						])
					]) : null
				]);
			}

			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "learning-assistant",
				order: 30
			}, Widget));

			ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: "dsh-plugin-learning-assistant#learning-assistant",
				locale: NS
			}, SettingsPage));

			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "learning-assistant-session-scan",
				order: 600,
				locale: NS
			}, SessionScanMenuItem));
		}

		return { inject, apply };
	}
});
