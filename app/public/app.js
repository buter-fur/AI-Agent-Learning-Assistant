/* 学习小助手 · v1 前端
 * 单页、无构建、无依赖。数据只从 /api/bundle 来，失败时回退 ./mock.json。
 * 视觉语言沿用 prototype：纸色 / 墨色 / 朱砂 / 宋体标题 + 苹方正文。
 */
(function () {
  'use strict';

  /* 嵌入 DSH 时页面在 /learning-assistant/ 下：把页面里的 /api/* 自动挂到同源代理下。
   * 独立打开（根路径）时 API_PREFIX 为空，行为不变。 */
  var API_PREFIX = /^\/learning-assistant(?:\/|$)/.test(window.location.pathname) ? '/learning-assistant' : '';
  if (API_PREFIX && typeof window.fetch === 'function') {
    var rawFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (typeof input === 'string' && input.indexOf('/api/') === 0) input = API_PREFIX + input;
      return rawFetch(input, init);
    };
  }

  /* ── 常量 ─────────────────────────────────────────────── */

  var LANE_ORDER = ['mechanism', 'syntax', 'algorithm', 'judgment'];

  var LANES = {
    mechanism: {
      name: '机制',
      question: '为什么会这样？',
      gift: '给你判断方向：先看哪里。'
    },
    syntax: {
      name: '语法',
      question: '这行代码在干嘛？',
      gift: '读出意图：它在做什么。'
    },
    algorithm: {
      name: '算法',
      question: '会不会慢、会不会崩？',
      gift: '判断代价：值不值。'
    },
    judgment: {
      name: '判断',
      question: '该选哪个、算做完了吗？',
      gift: '做决定、能验收。'
    }
  };

  var KIND = {
    prereq: { name: '前置', line: '不懂 A 就看不懂 B' },
    cause: { name: '因果', line: 'A 导致 B' },
    contrast: { name: '对比', line: '两个容易混' },
    same: { name: '同源', line: '同一个机制' }
  };

  var QUIZ_KIND = {
    recall: '回忆',
    apply: '应用',
    contrast: '对比',
    trace: '推演'
  };

  var REVIEW_TEXT = {
    got: '记下了。下次遇到同一个概念，它会自己回来。',
    nope: '记下了。下面换一种说法——',
    'too-easy': '记下了。下次这张卡会讲得更快。'
  };

  var API_ACTION = {
    got: 'got',
    nope: 'nope',
    'too-easy': 'too-easy'
  };

  var LIGHT_C = {
    ink: '#1b1a17',
    ink2: '#54504a',
    ink3: '#8b867d',
    line: '#e3ddd1',
    line2: '#d3ccbe',
    paper: '#f7f4ee',
    paper2: '#efeae0',
    card: '#fffdf9',
    accent: '#b4432e',
    accentSoft: '#f6e8e3',
    ok: '#3d6b52',
    okSoft: '#e8efe9',
    cause: '#8a5a3b',
    band: '#c9b99b',
    band2: '#e0d5c1',
    band3: '#b3a488',
    mapHalo: 'rgba(255,253,249,.95)',
    linkOn: 'rgba(180,67,46,.55)',
    link: 'rgba(120,110,95,.18)',
    linkDim: 'rgba(120,110,95,.06)'
  };
  var DARK_C = Object.assign({}, LIGHT_C, {
    ink: '#eee7d9',
    ink2: '#c9c0b1',
    ink3: '#9a8f80',
    line: '#3b352c',
    line2: '#514a3d',
    paper: '#161513',
    paper2: '#211f1b',
    card: '#26231e',
    accent: '#d46b50',
    accentSoft: '#3a231f',
    ok: '#83ad91',
    okSoft: '#1f2c24',
    cause: '#cb9872',
    band: '#6f6250',
    band2: '#4b4237',
    band3: '#8a7a63',
    mapHalo: 'rgba(22,21,19,.95)',
    linkOn: 'rgba(212,107,80,.7)',
    link: 'rgba(210,195,170,.22)',
    linkDim: 'rgba(210,195,170,.08)'
  });
  var C = Object.assign({}, LIGHT_C);

  var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';
  var MONO = 'ui-monospace,"SF Mono",Menlo,monospace';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var FIG_W = 420;
  var figSeq = 0;

  var VIEW_TITLE = {
    deck: '卡片流',
    quiz: '答题',
    map: '概念图',
    line: '一条线',
    kbmap: '知识地图'
  };

  var KB_MODES = [
    { id: 'tags', name: '标签网络', hint: '点一个标签：哪些知识用了它；两点相连＝常一起出现' },
    { id: 'code', name: '代码地图', hint: '按来源文件聚团：这条知识是在改哪个文件时学到的' },
    { id: 'semantic', name: '语义地图', hint: '按向量远近排：接了远程 embedding 用真语义，没接就是本地字面相似度' }
  ];

  /* ── 主题 ─────────────────────────────────────────────── */

  var THEME_KEY = 'learn-theme';
  var currentTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

  function applyTheme(theme, persist) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = currentTheme;
    if (persist) {
      try { localStorage.setItem(THEME_KEY, currentTheme); } catch (_e) {}
    }
    C = Object.assign({}, currentTheme === 'dark' ? DARK_C : LIGHT_C);
    KE_LANE = Object.assign({}, currentTheme === 'dark' ? DARK_KE_LANE : LIGHT_KE_LANE);
    KB_PROJECT_COLORS = (currentTheme === 'dark' ? DARK_KB_PROJECT_COLORS : LIGHT_KB_PROJECT_COLORS).slice();
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = currentTheme === 'dark' ? '浅色' : '深色';
      btn.setAttribute('aria-label', currentTheme === 'dark' ? '切换浅色模式' : '切换深色模式');
      btn.title = btn.getAttribute('aria-label');
    }
    try { if (state && state.bundle) render(); } catch (_e) {}
  }

  var LIGHT_KE_LANE = {
    mechanism: { name: '机制', color: '#3d6b52' },
    syntax: { name: '语法', color: '#8a5a2b' },
    algorithm: { name: '算法', color: '#3f5a78' },
    judgment: { name: '判断', color: '#b4432e' }
  };
  var DARK_KE_LANE = {
    mechanism: { name: '机制', color: '#8bb49b' },
    syntax: { name: '语法', color: '#d0a46a' },
    algorithm: { name: '算法', color: '#8fa9c8' },
    judgment: { name: '判断', color: '#d98975' }
  };
  var KE_LANE = Object.assign({}, LIGHT_KE_LANE);
  var LIGHT_KB_PROJECT_COLORS = ['#3d6b52', '#8a5a2b', '#3f5a78', '#b4432e', '#6b5b8a', '#2f6f6a', '#8a4b4b', '#5b6b3d', '#8b867d'];
  var DARK_KB_PROJECT_COLORS = ['#8bb49b', '#d0a46a', '#8fa9c8', '#d98975', '#b3a0d0', '#7fc1bb', '#d79a9a', '#a7ba7f', '#9a8f80'];
  var KB_PROJECT_COLORS = LIGHT_KB_PROJECT_COLORS.slice();

  var state = {
    bundle: null,
    source: '',
    loading: true,
    error: null,
    route: { view: 'deck', id: null },
    lane: 'all',
    showKnown: false,
    picks: {},
    revealed: {},
    reviews: {},
    mini: {},
    mapFocus: null,
    tagsData: null,
    tagsLoading: false,
    tagsError: null,
    tagsFocus: null,
    kbmapMode: 'tags',
    kbmap: null,
    kbmapLoading: false,
    kbmapError: null,
    codeMap: null,
    codeMapLoading: false,
    codeMapError: null,
    kbLane: 'all',
    kbProject: 'all',
    kbColor: 'lane',
    kbQuery: '',
    kbPick: null,
    kbPickType: null,
    kbLogCount: 0,
    kbLocate: null,
    kbLocateLoading: false,
    kbLocateError: null,
    guide: null,
    guideKind: null,
    guideLoading: false,
    weekly: null,
    weeklyWarm: true,
    weeklyLoading: false,
    deckShown: 5,
    lineLane: 'mechanism',
    quiz: null
  };

  var resizeTimer = null;

  /* ── 小工具 ───────────────────────────────────────────── */

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (val === null || val === undefined || val === false) return;
        if (key === 'class') { node.className = val; return; }
        if (key === 'text') { node.textContent = val; return; }
        if (key === 'dataset') {
          Object.keys(val).forEach(function (k) { node.dataset[k] = val[k]; });
          return;
        }
        if (key === 'on') {
          Object.keys(val).forEach(function (ev) { node.addEventListener(ev, val[ev]); });
          return;
        }
        if (val === true) { node.setAttribute(key, ''); return; }
        node.setAttribute(key, val);
      });
    }
    appendKids(node, children);
    return node;
  }

  function appendKids(node, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) {
      children.forEach(function (child) { appendKids(node, child); });
      return;
    }
    if (typeof children === 'string' || typeof children === 'number') {
      node.appendChild(document.createTextNode(String(children)));
      return;
    }
    node.appendChild(children);
  }

  function sv(tag, attrs, text) {
    var node = document.createElementNS(SVGNS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (val === null || val === undefined) return;
        node.setAttribute(key, val);
      });
    }
    if (text !== null && text !== undefined) node.textContent = text;
    return node;
  }

  function txt(parent, x, y, text, opts) {
    opts = opts || {};
    var node = sv('text', {
      x: x,
      y: y,
      'font-size': opts.size || 12,
      fill: opts.fill || C.ink3,
      'font-family': opts.mono ? MONO : FONT,
      'text-anchor': opts.anchor || 'start',
      'font-weight': opts.weight || 400,
      'letter-spacing': opts.spacing || 0
    });
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function txtLines(parent, x, y, lines, opts, lineHeight) {
    lines.forEach(function (lineText, i) {
      txt(parent, x, y + i * (lineHeight || 16), lineText, opts);
    });
  }

  function rect(parent, x, y, w, h, opts) {
    opts = opts || {};
    var node = sv('rect', {
      x: x,
      y: y,
      width: Math.max(0, w),
      height: Math.max(0, h),
      rx: opts.rx || 0,
      fill: opts.fill || 'transparent',
      stroke: opts.stroke || 'none',
      'stroke-width': opts.sw || 1
    });
    parent.appendChild(node);
    return node;
  }

  function line(parent, x1, y1, x2, y2, opts) {
    opts = opts || {};
    var node = sv('line', {
      x1: x1,
      y1: y1,
      x2: x2,
      y2: y2,
      stroke: opts.stroke || C.line2,
      'stroke-width': opts.width || 1,
      'stroke-linecap': 'round',
      'stroke-dasharray': opts.dash || ''
    });
    parent.appendChild(node);
    return node;
  }

  function circle(parent, cx, cy, r, opts) {
    opts = opts || {};
    var node = sv('circle', {
      cx: cx,
      cy: cy,
      r: r,
      fill: opts.fill || C.card,
      stroke: opts.stroke || C.line2,
      'stroke-width': opts.sw || 1
    });
    parent.appendChild(node);
    return node;
  }

  function path(parent, d, opts) {
    opts = opts || {};
    var node = sv('path', {
      d: d,
      fill: opts.fill || 'none',
      stroke: opts.stroke || C.line2,
      'stroke-width': opts.width || 1,
      'stroke-linecap': 'round',
      'stroke-dasharray': opts.dash || '',
      'marker-end': opts.marker || ''
    });
    parent.appendChild(node);
    return node;
  }

  function wrapText(value, maxChars, maxLines) {
    var chars = Array.from(String(value == null ? '' : value));
    var lines = [];
    var i = 0;
    while (i < chars.length) {
      var remaining = chars.length - i;
      if (remaining <= maxChars) {
        lines.push(chars.slice(i).join(''));
        break;
      }
      var slice = chars.slice(i, i + maxChars);
      var breakAt = -1;
      for (var j = slice.length - 1; j > Math.floor(maxChars * 0.5); j--) {
        if (slice[j] === ' ') { breakAt = j; break; }
      }
      if (breakAt > 0) {
        lines.push(chars.slice(i, i + breakAt).join(''));
        i += breakAt + 1;
        while (i < chars.length && chars[i] === ' ') i++;
      } else {
        lines.push(slice.join(''));
        i += maxChars;
      }
    }
    if (!lines.length) lines.push('');
    if (maxLines && lines.length > maxLines) {
      var kept = lines.slice(0, maxLines);
      kept[maxLines - 1] = kept[maxLines - 1].slice(0, Math.max(1, maxChars - 1)) + '…';
      return kept;
    }
    return lines;
  }

  function clamp(num, min, max) {
    num = Number(num);
    if (isNaN(num)) return min;
    return Math.max(min, Math.min(max, num));
  }

  function isAnswered(value) {
    return typeof value === 'number' && value >= 0;
  }

  function letter(i) {
    return String.fromCharCode(65 + i);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function scrollIntoViewSafe(node, block) {
    if (!node || !node.scrollIntoView) return;
    node.scrollIntoView({ block: block || 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  function postJSON(url, payload) {
    if (!window.fetch) return;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json().catch(function () { return null; });
    }).catch(function () {
      /* 静默失败：本地反馈已经给过了 */
    });
  }

  function paintCardCount() {
    var totalNode = document.getElementById('card-count-total');
    var unseenNode = document.getElementById('card-count-unseen');
    if (!totalNode || !unseenNode) return;
    var stats = (state.bundle && state.bundle.stats) || {};
    var total = Number(stats.cards) || (state.bundle && state.bundle.cards ? state.bundle.cards.length : 0);
    var unseen = Number(stats.unseen) || 0;
    totalNode.textContent = String(total);
    if (unseen > 0) {
      unseenNode.textContent = '+' + unseen;
      unseenNode.hidden = false;
      unseenNode.setAttribute('aria-label', unseen + ' 张还没翻开');
    } else {
      unseenNode.hidden = true;
      unseenNode.removeAttribute('aria-label');
    }
  }

  function refreshCardCount() {
    if (!window.fetch) return;
    fetch('/api/card/status', { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.ok || !state.bundle) return;
        state.bundle.stats = state.bundle.stats || {};
        state.bundle.stats.cards = data.total;
        state.bundle.stats.unseen = data.unseen;
        paintCardCount();
      })
      .catch(function () { /* 本地服务重启时静默 */ });
  }

  function markCardSeen(cardId) {
    if (!cardId || !window.fetch) return;
    var card = state.bundle && state.bundle.cards.filter(function (c) { return c.id === cardId; })[0];
    if (card && card.seenAt) return;
    fetch('/api/card/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardId: cardId })
    }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      if (!data || !data.ok) return;
      if (card) card.seenAt = Date.now();
      if (state.bundle) {
        state.bundle.stats = state.bundle.stats || {};
        state.bundle.stats.cards = data.total;
        state.bundle.stats.unseen = data.unseen;
      }
      paintCardCount();
    }).catch(function () { /* 不阻塞阅读 */ });
  }

  /* ── 数据 ─────────────────────────────────────────────── */

  function fetchJSON(url) {
    return fetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function fetchBundle() {
    return fetchJSON('/api/bundle').then(function (raw) {
      return { raw: raw, source: 'api' };
    }).catch(function () {
      return fetchJSON('./mock.json').then(function (raw) {
        return { raw: raw, source: 'mock' };
      });
    }).then(function (result) {
      var bundle = normalizeBundle(result.raw);
      if (!bundle.cards.length) throw new Error('bundle has no cards');
      return { bundle: bundle, source: result.source };
    });
  }

  function normalizeBundle(raw) {
    raw = raw || {};

    var conceptMap = {};
    var concepts = (Array.isArray(raw.concepts) ? raw.concepts : []).filter(function (c) {
      return c && c.id;
    }).map(function (c) {
      var copy = Object.assign({}, c);
      copy.domain = copy.domain || '未分簇';
      copy.problem = copy.problem || '';
      copy.name = copy.name || copy.id;
      copy.desc = copy.desc || '';
      copy.level = clamp(copy.level, 0, 5);
      conceptMap[copy.id] = copy;
      return copy;
    });

    var cardMap = {};
    var cards = (Array.isArray(raw.cards) ? raw.cards : []).filter(function (c) {
      return c && c.id;
    }).map(function (c) {
      var copy = Object.assign({}, c);
      copy.options = Array.isArray(c.options) ? c.options.slice() : [];
      copy.terms = Array.isArray(c.terms) ? c.terms : [];
      copy.quiz = Array.isArray(c.quiz) ? c.quiz : [];
      copy.lane = copy.lane || 'mechanism';
      copy.title = copy.title || '没有标题的卡片';
      copy.answerIndex = Number(copy.answerIndex);
      // 选项不足以构成真正的选择时（例如工作流/判断卡只有「我不知道」），
      // 改用「先想后看」：不强迫用户从唯一选项里猜，直接在心智里过一遍再翻面。
      var realOptions = copy.options.filter(function (text) {
        return typeof text === 'string' && text.trim() && text.trim() !== '我不知道';
      });
      copy.reviewMode = (c.reviewMode === 'reveal' || realOptions.length < 2) ? 'reveal' : 'choice';
      if (copy.reviewMode === 'reveal') {
        copy.options = [];
        copy.answerIndex = -1;
      } else {
        if (copy.options.indexOf('我不知道') === -1) copy.options.push('我不知道');
        if (!(copy.answerIndex >= 0 && copy.answerIndex < copy.options.length) ||
            copy.options[copy.answerIndex] === '我不知道') {
          copy.answerIndex = -1;
        }
      }
      if (copy.conceptId && !conceptMap[copy.conceptId]) copy.conceptId = '';
      cardMap[copy.id] = copy;
      return copy;
    });

    var allowedKinds = { prereq: 1, cause: 1, contrast: 1, same: 1 };
    var edges = (Array.isArray(raw.edges) ? raw.edges : []).filter(function (e) {
      return e && allowedKinds[e.kind] && conceptMap[e.from] && conceptMap[e.to] && e.from !== e.to;
    }).map(function (e) {
      return {
        from: e.from,
        to: e.to,
        kind: e.kind,
        reason: e.reason || ''
      };
    });

    return {
      cards: cards,
      concepts: concepts,
      edges: edges,
      states: raw.states || {},
      stats: raw.stats || {},
      conceptMap: conceptMap,
      cardMap: cardMap
    };
  }

  function buildQuizItems(bundle) {
    var items = [];
    bundle.cards.forEach(function (card) {
      card.quiz.forEach(function (q, index) {
        if (q && Array.isArray(q.options) && q.options.length) {
          items.push({ card: card, quiz: q, quizIndex: index });
        }
      });
    });
    return items;
  }

  function quizKey(item) {
    return item.card.id + '::' + item.quizIndex;
  }

  function ensureQuiz(force) {
    if (force || !state.quiz) {
      state.quiz = {
        items: buildQuizItems(state.bundle),
        index: 0,
        answers: {},
        done: false
      };
    }
    return state.quiz;
  }

  /* ── 路由 ─────────────────────────────────────────────── */

  function parseRoute() {
    var raw = (window.location.hash || '').replace(/^#\/?/, '');
    var parts = raw.split('/').filter(function (p) { return p; });
    var mode = null;
    var id = null;
    if (parts[0] === 'tags') {                       // 旧链接 #tags/xxx 直接并进知识地图
      mode = 'tags';
      if (parts[1]) { try { id = decodeURIComponent(parts[1]); } catch (err) { id = parts[1]; } }
      return { view: 'kbmap', mode: mode, id: id };
    }
    var view = ['deck', 'quiz', 'map', 'line', 'kbmap'].indexOf(parts[0]) !== -1 ? parts[0] : 'deck';
    if (view === 'kbmap') {
      mode = ['semantic', 'tags', 'code'].indexOf(parts[1]) !== -1 ? parts[1] : null;
      if (parts[2]) { try { id = decodeURIComponent(parts[2]); } catch (err) { id = parts[2]; } }
    } else if (parts[1]) {
      try { id = decodeURIComponent(parts[1]); } catch (err) { id = parts[1]; }
    }
    return { view: view, mode: mode, id: id };
  }

  function go(hash) {
    if (window.location.hash === hash) {
      applyRoute(false);
      return;
    }
    window.location.hash = hash;
  }

  function applyRoute(initial) {
    if (!state.bundle) return;

    var route = parseRoute();
    var prevView = state.route ? state.route.view : null;
    state.route = route;

    if (route.view === 'map') {
      state.mapFocus = (route.id && state.bundle.conceptMap[route.id]) ? route.id : null;
    }

    if (route.view === 'kbmap') {
      var mode = route.mode || 'tags';
      if (mode !== state.kbmapMode) state.kbPick = null;
      state.kbmapMode = mode;
      if (route.id) {
        state.kbPick = route.id;
        state.kbPickType = mode;
        if (mode === 'tags') state.tagsFocus = route.id;
      }
    }

    if (route.view === 'line') {
      if (route.id && LANES[route.id]) state.lineLane = route.id;
      else if (!LANES[state.lineLane]) state.lineLane = 'mechanism';
    }

    if (route.view === 'deck' && route.id && state.bundle.cardMap[route.id]) {
      state.lane = 'all';
      state.revealed[route.id] = true;
      var targetIndex = state.bundle.cards.findIndex(function (card) { return card.id === route.id; });
      if (targetIndex >= 0) state.deckShown = Math.max(state.deckShown || 5, targetIndex + 1);
    }

    if (route.view === 'quiz') ensureQuiz(false);

    render();

    if (initial || prevView !== route.view) {
      window.scrollTo(0, 0);
    }

    if (route.view === 'deck' && route.id && state.bundle.cardMap[route.id]) {
      window.requestAnimationFrame(function () { scrollToCard(route.id); });
    }
  }

  function scrollToCard(cardId) {
    var node = document.getElementById('card-' + cardId);
    if (!node) return;
    scrollIntoViewSafe(node, 'start');
    node.classList.add('is-target');
    window.setTimeout(function () { node.classList.remove('is-target'); }, 1800);
  }

  /* ── 渲染入口 ─────────────────────────────────────────── */

  function init() {
    applyTheme(currentTheme, false);
    var themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', function () {
        applyTheme(currentTheme === 'dark' ? 'light' : 'dark', true);
      });
    }
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (event) {
        var saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (_e) {}
        if (!saved) applyTheme(event.matches ? 'dark' : 'light', false);
      });
    } catch (_e) {}
    bindNav();
    window.addEventListener('hashchange', function () {
      if (state.bundle) applyRoute(false);
    });
    window.addEventListener('resize', function () {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        if (state.route.view === 'map') layoutMap();
        if (state.route.view === 'kbmap') drawKbMap();
      }, 120);
    });
    loadData();
  }

  function bindNav() {
    $all('.nav a').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        var hash = a.getAttribute('href');
        if (window.location.hash === hash) {
          ev.preventDefault();
          applyRoute(false);
        }
      });
    });
    var brand = $('.brand');
    if (brand) {
      brand.addEventListener('click', function (ev) {
        if (window.location.hash === '#deck') {
          ev.preventDefault();
          applyRoute(false);
        }
      });
    }
  }

  function loadData() {
    state.loading = true;
    state.error = null;
    render();

    fetchBundle().then(function (result) {
      state.bundle = result.bundle;
      state.source = result.source;
      state.loading = false;
      paintCardCount();
      window.setInterval(refreshCardCount, 20000);
      state.quiz = null;
      state.deckShown = 5;
      state.mapFocus = null;
      applyRoute(true);
      window.setTimeout(function () { checkWeekly(); }, 350);
    }).catch(function (err) {
      state.loading = false;
      state.error = err;
      state.bundle = null;
      render();
    });
  }

  function updateNav() {
    var view = state.route ? state.route.view : 'deck';
    $all('.nav a').forEach(function (a) {
      if (a.getAttribute('data-view') === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function render() {
    updateNav();
    var main = $('#main');
    if (!main) return;
    main.textContent = '';

    if (state.loading) {
      main.appendChild(renderBoot());
      return;
    }
    if (state.error || !state.bundle) {
      main.appendChild(renderError());
      return;
    }

    var view = state.route.view;
    var node;
    if (view === 'quiz') node = renderQuiz();
    else if (view === 'map') node = renderMap();
    else if (view === 'line') node = renderLine();
    else if (view === 'kbmap') node = renderKbMap();
    else node = renderDeck();

    main.appendChild(node);
    document.body.setAttribute('data-view', view);
    document.title = VIEW_TITLE[view] + ' · 学习小助手';

    if (view === 'map') {
      window.requestAnimationFrame(layoutMap);
    }
    if (view === 'kbmap') {
      window.requestAnimationFrame(drawKbMap);
    }
  }

  function renderBoot() {
    return el('div', { class: 'boot', role: 'status' }, [
      el('div', { class: 'kicker' }, '学习小助手 · v1'),
      el('p', { class: 'boot-line' }, '正在把卡片摊开…')
    ]);
  }

  function renderError() {
    return el('div', { class: 'state-panel' }, [
      el('div', { class: 'kicker' }, '没有读到卡片'),
      el('h1', { class: 'state-title' }, '数据没有加载出来'),
      el('p', { class: 'state-text' }, '先确认本地服务在跑；没有服务端时，也应该能读到同目录的 mock.json。'),
      el('p', { class: 'state-code' }, '在 app/public 目录运行：python3 -m http.server 8000'),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        on: { click: function () { loadData(); } }
      }, '再试一次')
    ]);
  }

  /* ── 视图通用件 ───────────────────────────────────────── */

  function renderHero(opts) {
    var note = null;
    if (opts.note) {
      note = el('div', { class: 'view-head-note' }, [
        el('span', { class: 'note-rule' }),
        el('p', { text: opts.note })
      ]);
    }
    return el('header', { class: 'view-head' }, [
      el('div', { class: 'view-head-main' }, [
        el('div', { class: 'kicker' }, opts.kicker),
        el('h1', { text: opts.title }),
        el('p', { class: 'lede', text: opts.lede })
      ]),
      note
    ]);
  }

  function emptyPanel(title, body) {
    return el('div', { class: 'empty-panel' }, [
      el('p', { class: 'empty-title', text: title }),
      body ? el('p', { class: 'empty-body', text: body }) : null
    ]);
  }

  function laneName(key) {
    return (LANES[key] && LANES[key].name) || key || '未分线';
  }

  var RUNG_NAMES = ['认得', '看懂', '讲清', '判断', '迁移'];

  function rungInfo(conceptId) {
    var st = state.bundle && state.bundle.states && state.bundle.states[conceptId];
    var rung = st ? Math.max(0, Math.min(4, st.rung || 0)) : 0;
    return {
      rung: rung,
      label: 'G' + rung,
      name: RUNG_NAMES[rung],
      state: st ? st.state : 'unknown',
      mastery: st ? st.s : 0
    };
  }

  /* ── 卡片流 ───────────────────────────────────────────── */

  function renderDeck() {
    var wrap = el('section', { class: 'view view-deck' });
    wrap.appendChild(renderHero({
      kicker: '01 / 卡片流',
      title: '一张卡，只讲一件事',
      lede: '正面只给现场，背面才给讲法。能选的先猜一次；没有选项的卡先在心里过一遍。',
      note: '四条线：机制、语法、算法、判断。同一件事，你当时问的那句话不同，卡就落进不同的线。'
    }));

    wrap.appendChild(renderGuideStrip());

    var rail = el('aside', { class: 'deck-rail' }, [
      el('div', { class: 'rail-title' }, '从哪条线看'),
      el('div', { class: 'filter-list' }, buildFilters()),
      el('button', {
        class: 'known-toggle' + (state.showKnown ? ' is-on' : ''),
        type: 'button',
        on: { click: toggleKnown }
      }, knownLabel()),
      el('p', { class: 'rail-meta', id: 'rail-meta', text: deckMetaText() }),
      el('p', { class: 'rail-note' }, [
        el('b', {}, '先猜再看。'),
        ' 选项点下去只告诉你对不对，解析在背面。'
      ])
    ]);

    var list = el('div', { class: 'deck-list', id: 'deck-list' });
    fillDeckList(list);

    wrap.appendChild(el('div', { class: 'deck-layout' }, [rail, list]));
    window.requestAnimationFrame(paintGuide);
    return wrap;
  }

  /* ── 引导：顺着这张网走 ───────────────────────────────── */

  function renderGuideStrip() {
    var actions = [
      { kind: 'next', name: '顺藤摸瓜', hint: '从当前前沿推一个最近的邻居' },
      { kind: 'path', name: '一条路', hint: '前置 → 当前 → 之后，看整段' },
      { kind: 'gaps', name: '缺口', hint: '碰过 ≥3 次、却还没学的' }
    ];
    return el('div', { class: 'guide-strip' }, [
      el('div', { class: 'guide-head' }, [
        el('span', { class: 'guide-kicker', text: '顺着这张网走' }),
        el('span', { class: 'guide-sub', text: '不确定看什么的时候，从这里点一下。' })
      ]),
      el('div', { class: 'guide-actions' }, actions.map(function (a) {
        return el('button', {
          class: 'guide-btn' + (state.guideKind === a.kind ? ' is-on' : ''),
          type: 'button',
          title: a.hint,
          'data-guide': a.kind,
          on: { click: function () { requestGuide(a.kind); } }
        }, [
          el('b', { text: a.name }),
          el('span', { text: a.hint })
        ]);
      })),
      el('div', { class: 'guide-panel', id: 'guide-panel', 'aria-live': 'polite' })
    ]);
  }

  function requestGuide(kind) {
    if (state.guideKind === kind && state.guide && !state.guideLoading) {
      state.guideKind = null;
      state.guide = null;
      paintGuide();
      return;
    }
    state.guideKind = kind;
    state.guide = null;
    state.guideLoading = true;
    paintGuide();
    var url = kind === 'next' ? '/api/guide/next' : kind === 'path' ? '/api/guide/path' : '/api/guide/gaps';
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      state.guide = data;
      state.guideLoading = false;
      paintGuide();
    }).catch(function (err) {
      state.guide = { ok: false, error: String(err && err.message || err) };
      state.guideLoading = false;
      paintGuide();
    });
  }

  function paintGuide() {
    $all('.guide-btn').forEach(function (btn) {
      var on = btn.getAttribute('data-guide') === state.guideKind;
      btn.classList.toggle('is-on', on);
    });
    var panel = document.getElementById('guide-panel');
    if (!panel) return;
    panel.textContent = '';
    if (!state.guideKind) return;
    panel.hidden = false;
    if (state.guideLoading) {
      panel.appendChild(el('p', { class: 'guide-loading', text: '正在沿着边找一个…' }));
      return;
    }
    var d = state.guide || {};
    if (d.ok === false) {
      panel.appendChild(el('p', { class: 'guide-empty', text: '没取到建议：' + (d.error || '接口没起') }));
      return;
    }
    if (state.guideKind === 'next') {
      var g = d.suggestion;
      if (!g) {
        panel.appendChild(el('p', { class: 'guide-empty', text: '这张网暂时没有可推的下一步。先翻一张卡，概念才会有邻居。' }));
        return;
      }
      panel.appendChild(el('div', { class: 'guide-item' }, [
        el('div', { class: 'guide-item-head' }, [
          el('span', { class: 'guide-kind', text: g.kindLabel || '同源' }),
          el('b', { text: g.concept.name }),
          g.via ? el('span', { class: 'guide-via', text: '经 ' + g.via }) : null
        ]),
        el('p', { class: 'guide-reason', text: g.reason || '同一张网上挨得比较近。' }),
        el('div', { class: 'guide-links' }, [
          g.card ? el('button', { class: 'btn btn-quiet', type: 'button', on: { click: function () { go('#deck/' + encodeURIComponent(g.card.id)); } } }, '看这张：' + g.card.title) : null,
          el('button', { class: 'btn btn-quiet', type: 'button', on: { click: function () { go('#map/' + encodeURIComponent(g.concept.id)); } } }, '在图上看看')
        ])
      ]));
      return;
    }
    if (state.guideKind === 'path') {
      var steps = d.steps || [];
      if (!steps.length) {
        panel.appendChild(el('p', { class: 'guide-empty', text: '没有可连成串的前置。这个知识点暂时是孤立的。' }));
        return;
      }
      var list = el('ol', { class: 'guide-path' });
      steps.forEach(function (s) {
        list.appendChild(el('li', {}, [
          el('span', { class: 'guide-role', text: s.role }),
          el('span', { text: s.concept.name })
        ]));
      });
      panel.appendChild(list);
      return;
    }
    var gaps = d.gaps || [];
    if (!gaps.length) {
      panel.appendChild(el('p', { class: 'guide-empty', text: '暂时没有缺口。碰过 ≥3 次、还没学的概念会出现在这里。' }));
      return;
    }
    var wrap = el('div', { class: 'guide-gaps' });
    gaps.forEach(function (x) {
      wrap.appendChild(el('button', {
        class: 'guide-gap', type: 'button',
        on: { click: function () { go('#map/' + encodeURIComponent(x.concept.id)); } }
      }, [
        el('b', { text: x.concept.name }),
        el('span', { text: '遇到 ' + x.count + ' 次' })
      ]));
    });
    panel.appendChild(wrap);
  }

  function buildFilters() {
    var buttons = [];
    buttons.push(filterButton('all', '全部', '每一条线都看'));
    LANE_ORDER.forEach(function (key) {
      buttons.push(filterButton(key, LANES[key].name, LANES[key].question));
    });
    return buttons;
  }

  function filterButton(key, name, question) {
    var on = state.lane === key;
    return el('button', {
      class: 'filter' + (on ? ' is-on' : ''),
      type: 'button',
      'data-lane': key,
      'aria-pressed': on ? 'true' : 'false',
      on: {
        click: function () { selectLane(key); }
      }
    }, [
      el('span', { class: 'n', text: name }),
      question ? el('span', { class: 'q', text: question }) : null
    ]);
  }

  function selectLane(key) {
    state.lane = key;
    state.deckShown = 5;
    $all('.filter').forEach(function (btn) {
      var on = btn.getAttribute('data-lane') === key;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var list = $('#deck-list');
    if (list) fillDeckList(list);
  }

  function isLearnedCard(card) {
    var st = state.bundle && state.bundle.states && state.bundle.states[card.conceptId];
    return !!st && st.state === 'known';
  }

  function knownCount() {
    return state.bundle.cards.filter(isLearnedCard).length;
  }

  function knownLabel() {
    var n = knownCount();
    return '已会 ' + n + ' 张 · ' + (state.showKnown ? '正在显示' : '已隐藏（点开看）');
  }

  function deckMetaText() {
    var limit = (state.bundle && state.bundle.stats && state.bundle.stats.cardLimit) || 50;
    var total = state.bundle ? state.bundle.cards.length : 0;
    var known = knownCount();
    return '未学 ' + (total - known) + ' / 上限 ' + limit + ' · 已会 ' + known + ' 张隐藏（复习答错会自动回来）';
  }

  function toggleKnown() {
    state.showKnown = !state.showKnown;
    var btn = $('.known-toggle');
    if (btn) {
      btn.textContent = knownLabel();
      btn.classList.toggle('is-on', state.showKnown);
    }
    var list = $('#deck-list');
    if (list) fillDeckList(list);
  }

  function fillDeckList(container) {
    var laneCards = state.bundle.cards.filter(function (card) {
      return state.lane === 'all' || card.lane === state.lane;
    });
    var cards = laneCards.filter(function (card) {
      if (!isLearnedCard(card)) return true;
      if (state.showKnown) return true;
      return state.route && state.route.view === 'deck' && state.route.id === card.id;
    });
    container.textContent = '';
    if (!cards.length) {
      if (laneCards.length) {
        container.appendChild(emptyPanel('这条线的卡都学会了。', '要回看的话，点左边「已会 … 已隐藏」把它展开。'));
      } else {
        container.appendChild(emptyPanel('这条线还没有卡片。', '等下一张卡从会话里长出来。'));
      }
      return;
    }
    var shown = Math.min(cards.length, state.deckShown || 5);
    cards.slice(0, shown).forEach(function (card) {
      container.appendChild(renderCard(card));
    });
    if (shown < cards.length) {
      container.appendChild(el('div', { class: 'deck-more' }, [
        el('button', {
          class: 'btn btn-ghost deck-more-btn',
          type: 'button',
          on: {
            click: function () {
              state.deckShown = shown + 5;
              fillDeckList(container);
            }
          }
        }, '再看 5 张'),
        el('span', { class: 'deck-more-hint', text: '一张一张看，不急着翻完。' })
      ]));
    }
  }

  function renderCard(card) {
    var lane = LANES[card.lane] || { name: laneName(card.lane), question: '' };
    var ri = rungInfo(card.conceptId);
    var revealMode = card.reviewMode === 'reveal';
    var topHint = el('span', { class: 'card-top-hint', text: revealMode ? '先想一遍' : '先猜一次' });
    var feedback = el('div', { class: 'feedback', role: 'status', 'aria-live': 'polite' });
    var options = el('div', { class: 'options', role: 'group', 'aria-label': '选项' });
    options.hidden = revealMode;

    var reflect = revealMode ? el('div', { class: 'card-reflect' }, [
      el('p', { class: 'card-reflect-main', text: '这类问题没有合适的选项。先在心里过一遍：如果是你，第一步会做什么？' }),
      el('p', { class: 'card-reflect-hint', text: '不用答题，想清楚再翻面。看的是判断顺序，不是选对字母。' })
    ]) : null;

    var article = el('article', {
      class: 'card',
      id: 'card-' + card.id,
      'data-card': card.id
    }, [
      el('div', { class: 'card-top' }, [
        el('span', { class: 'card-lane', text: lane.name }),
        el('span', { class: 'card-rung', id: 'rung-' + card.id, title: '学习档位：G0 认得 → G4 迁移', text: ri.label + ' · ' + ri.name }),
        topHint
      ]),
      el('h2', { class: 'card-title', text: card.title }),
      card.scene ? el('p', { class: 'card-scene', text: card.scene }) : null,
      card.question ? el('p', { class: 'card-question', text: card.question }) : null,
      reflect,
      options,
      feedback
    ]);

    card.options.forEach(function (text, i) {
      var opt = el('button', {
        class: 'option',
        type: 'button',
        'data-index': i,
        on: {
          click: function () {
            state.picks[card.id] = i;
            paintOptions();
          }
        }
      }, [
        el('span', { class: 'key', text: letter(i) }),
        el('span', { class: 'txt', text: text }),
        el('span', { class: 'mark' })
      ]);
      options.appendChild(opt);
    });

    function paintOptions() {
      if (revealMode) {
        topHint.textContent = state.revealed[card.id] ? '背面' : '先想一遍';
        return;
      }
      var picked = state.picks[card.id];
      var answered = isAnswered(picked) && picked < card.options.length;
      var badData = card.answerIndex < 0;

      Array.prototype.forEach.call(options.children, function (opt, i) {
        opt.className = 'option';
        opt.removeAttribute('aria-pressed');
        var mark = opt.querySelector('.mark');
        mark.textContent = '';
        if (!answered) return;

        var isPicked = i === picked;
        var isCorrect = i === card.answerIndex;
        if (isPicked) {
          opt.classList.add('is-picked');
          opt.setAttribute('aria-pressed', 'true');
        }
        if (isPicked && isCorrect && !badData) {
          opt.classList.add('is-right');
          mark.textContent = '对';
        } else if (isPicked && card.options[i] === '我不知道') {
          opt.classList.add('is-neutral');
          mark.textContent = '没事';
        } else if (isPicked && !badData) {
          opt.classList.add('is-wrong');
          mark.textContent = '不是这个';
        } else if (!isPicked) {
          opt.classList.add('is-muted');
        }
      });

      if (!answered) {
        feedback.className = 'feedback';
        feedback.textContent = '';
      } else if (badData) {
        feedback.className = 'feedback';
        feedback.textContent = '这张卡的数据有点问题，先翻到背面看。';
      } else if (card.options[picked] === '我不知道') {
        feedback.className = 'feedback';
        feedback.textContent = '没关系，这张卡就是讲它的。翻到背面。';
      } else if (picked === card.answerIndex) {
        feedback.className = 'feedback ok';
        feedback.textContent = '对，就是它。翻到背面看为什么。';
      } else {
        feedback.className = 'feedback bad';
        feedback.textContent = '先记住你的答案——翻到背面，看它差在哪。';
      }

      if (state.revealed[card.id]) topHint.textContent = '背面';
      else if (answered) topHint.textContent = '猜过了';
      else topHint.textContent = '先猜一次';
    }

    var revealBtn = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      'aria-expanded': state.revealed[card.id] ? 'true' : 'false',
      on: {
        click: function () {
          setRevealed(!state.revealed[card.id]);
        }
      }
    }, state.revealed[card.id] ? '收起来' : (revealMode ? '想好了，看答案' : '我猜完了，看答案'));

    var revealHint = el('span', {
      class: 'reveal-hint',
      text: state.revealed[card.id] ? '' : (revealMode ? '不用猜选项；翻面看它怎么判断。' : '答案、图、比喻和来源，都在背面。')
    });

    article.appendChild(el('div', { class: 'reveal-row' }, [revealBtn, revealHint]));

    var back = renderBack(card);
    back.hidden = !state.revealed[card.id];
    article.appendChild(back);

    function setRevealed(open) {
      state.revealed[card.id] = open;
      back.hidden = !open;
      revealBtn.textContent = open ? '收起来' : (revealMode ? '想好了，看答案' : '我猜完了，看答案');
      revealBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      revealHint.textContent = open ? '' : (revealMode ? '不用猜选项；翻面看它怎么判断。' : '答案、图、比喻和来源，都在背面。');
      topHint.textContent = open ? '背面' : (revealMode ? '先想一遍' : (isAnswered(state.picks[card.id]) ? '猜过了' : '先猜一次'));
      if (open) {
        markCardSeen(card.id);
        window.requestAnimationFrame(function () {
          scrollIntoViewSafe(back, 'nearest');
        });
      }
    }

    paintOptions();
    return article;
  }

  function backBlock(label, child, extraClass) {
    return el('section', { class: 'back-block' + (extraClass ? ' ' + extraClass : '') }, [
      el('div', { class: 'block-label' }, el('span', {}, label)),
      child
    ]);
  }

  function renderBack(card) {
    var back = el('div', { class: 'card-back' });
    var concept = card.conceptId && state.bundle.conceptMap[card.conceptId];

    if (concept) {
      back.appendChild(el('div', { class: 'back-meta' }, [
        el('span', { class: 'back-meta-label', text: '概念' }),
        el('button', {
          class: 'inline-link',
          type: 'button',
          on: {
            click: function () { go('#map/' + encodeURIComponent(concept.id)); }
          }
        }, concept.name),
        el('span', { class: 'back-meta-hint', text: '在图上看看它连着谁' })
      ]));
    }

    back.appendChild(renderRungBlock(card));
    back.appendChild(backBlock('答案',
      el('p', { class: 'answer', text: card.answer || '这张卡还没有写答案。' })
    ));

    if (card.figure) {
      var figBlock = renderFigureBlock(card.figure);
      if (figBlock) back.appendChild(backBlock('一张图', figBlock));
    }

    if (card.metaphor) {
      back.appendChild(backBlock('打个比方',
        el('p', { class: 'metaphor', text: card.metaphor })
      ));
    }

    if (card.explain) {
      back.appendChild(backBlock('讲明白',
        el('p', { class: 'explain', text: card.explain })
      ));
    }

    if (card.terms && card.terms.length) {
      var dl = el('dl', { class: 'terms' });
      card.terms.forEach(function (term) {
        dl.appendChild(el('dt', { text: term.term }));
        dl.appendChild(el('dd', { text: term.plain }));
      });
      back.appendChild(backBlock('术语', dl));
    }

    if (card.takeaway) {
      back.appendChild(backBlock('带走一句',
        el('div', { class: 'take' }, card.takeaway)
      ));
    }

    if (card.boundary && Array.isArray(card.boundary.options) && card.boundary.options.length) {
      back.appendChild(backBlock('边界题', renderBoundary(card)));
    }

    if (card.quiz && card.quiz.length) {
      back.appendChild(renderVariantFold(card));
    }

    back.appendChild(renderReview(card));
    back.appendChild(renderSource(card));
    return back;
  }

  function renderRungBlock(card) {
    var ri = rungInfo(card.conceptId);
    var btn = el('button', {
      class: 'btn btn-quiet',
      type: 'button',
      disabled: ri.rung >= 4,
      on: { click: function () { raiseRung(card, btn); } }
    }, ri.rung >= 4 ? '已到 G4' : '太浅了，升一档 ↑');
    return el('section', { class: 'rung-block' }, [
      el('div', { class: 'rung-head' }, [
        el('span', { class: 'rung-badge', text: ri.label }),
        el('b', { text: ri.name }),
        el('span', { class: 'rung-note', text: '档位跟着你答对什么走：答对两种不同题型、隔一周，才升一档。' })
      ]),
      el('div', { class: 'rung-actions' }, [
        btn,
        el('button', {
          class: 'btn btn-ghost', type: 'button',
          on: {
            click: function () {
              var back = btn.closest('.card-back');
              var b = back && back.querySelector('.review-btn[data-action="nope"]');
              if (b) { b.click(); scrollIntoViewSafe(b, 'nearest'); }
            }
          }
        }, '没懂 · 当档重讲'),
        el('span', { class: 'rung-hint', text: '太浅：手动 +1 档；没懂：当档重讲，不降档（降档只在你连续答错时自动发生）。' })
      ])
    ]);
  }

  function raiseRung(card, btn) {
    btn.disabled = true;
    fetch('/api/card/rung', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cardId: card.id, action: 'up' })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '没成功');
      if (!state.bundle.states) state.bundle.states = {};
      var st = state.bundle.states[card.conceptId] || (state.bundle.states[card.conceptId] = { state: 'unknown', s: 0, rung: 0 });
      st.rung = d.rung;
      var name = RUNG_NAMES[d.rung];
      var badge = document.getElementById('rung-' + card.id);
      if (badge) badge.textContent = 'G' + d.rung + ' · ' + name;
      var block = btn.closest('.rung-block');
      if (block) {
        var b = block.querySelector('.rung-badge');
        if (b) b.textContent = 'G' + d.rung;
        var nm = block.querySelector('.rung-head b');
        if (nm) nm.textContent = name;
      }
      btn.textContent = d.rung >= 4 ? '已到 G4' : '太浅了，升一档 ↑';
      btn.disabled = d.rung >= 4;
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = '没生效：' + String(err && err.message || err);
    });
  }

  function renderVariantFold(card) {
    var details = el('details', { class: 'variant-fold' });
    details.appendChild(el('summary', {}, [
      el('span', { class: 'variant-title', text: '再做 ' + card.quiz.length + ' 道变式题' }),
      el('span', { class: 'variant-hint', text: '换一个场景，再试一次' })
    ]));
    details.appendChild(el('div', { class: 'variant-body' }, renderCardQuizList(card)));
    return details;
  }

  function renderReview(card) {
    var note = el('div', { class: 'review-note', role: 'status', 'aria-live': 'polite' });
    var alt = el('div', { class: 'alt-box', hidden: true });
    var wrap = el('div', { class: 'review' });

    var buttons = [
      reviewButton('got', '懂了'),
      reviewButton('nope', '没懂，换个说法'),
      reviewButton('too-easy', '这张太简单')
    ];
    wrap.appendChild(el('div', { class: 'review-actions' }, buttons));
    wrap.appendChild(note);
    wrap.appendChild(alt);

    function reviewButton(action, label) {
      return el('button', {
        class: 'btn ' + (action === 'got' ? 'btn-primary' : 'btn-ghost') + ' review-btn',
        type: 'button',
        'data-action': action,
        on: {
          click: function () { choose(action); }
        }
      }, label);
    }

    function paint() {
      var current = state.reviews[card.id] && state.reviews[card.id].action;
      buttons.forEach(function (btn) {
        var on = btn.getAttribute('data-action') === current;
        btn.classList.toggle('is-chosen', on);
      });
      if (!current) {
        note.className = 'review-note';
        note.textContent = '';
        alt.hidden = true;
        return;
      }
      note.className = 'review-note' + (current === 'got' ? ' ok' : '');
      note.textContent = REVIEW_TEXT[current] || '';
      if (current === 'nope' && card.metaphor) {
        alt.hidden = false;
        alt.textContent = '换个说法：' + card.metaphor;
      } else if (current === 'nope') {
        note.textContent = '记下了，下次换一种讲法。';
        alt.hidden = true;
      } else {
        alt.hidden = true;
      }
    }

    function choose(action) {
      var current = state.reviews[card.id] && state.reviews[card.id].action;
      if (current === action) return;
      state.reviews[card.id] = { action: action };
      paint();
      postJSON('/api/review', { cardId: card.id, action: API_ACTION[action] || action });
    }

    paint();
    return wrap;
  }

  function renderSource(card) {
    var source = card.source || {};
    var quotes = Array.isArray(source.quotes) ? source.quotes : [];
    var details = el('details', { class: 'source' });
    var summary = el('summary', {}, [
      el('span', {}, '看当时的现场'),
      quotes.length ? el('span', { class: 'source-count', text: quotes.length + ' 行原文' }) : null
    ]);
    details.appendChild(summary);

    var body = el('div', { class: 'source-body' });
    if (source.project || source.session || source.time) {
      body.appendChild(el('div', { class: 'source-meta' }, [
        source.project ? el('span', {}, source.project) : null,
        source.session ? el('span', {}, '会话 ' + source.session) : null,
        source.time ? el('span', {}, source.time) : null
      ]));
    }
    if (source.session) {
      body.appendChild(el('div', { class: 'source-actions' }, [
        el('button', {
          class: 'btn btn-quiet', type: 'button',
          on: { click: function () { openLocate({ session: source.session, seq: source.seq, quote: (quotes[0] || {}).text }); } }
        }, '回到现场'),
        el('span', { class: 'source-actions-hint', text: '读本地会话日志，把这段话前后几条真实消息取回来。' })
      ]));
    }
    if (quotes.length) {
      quotes.forEach(function (q) {
        var who = q.who === 'user' ? '你' : (q.who === 'assistant' ? '助手' : (q.who || '记录'));
        body.appendChild(el('div', { class: 'source-quote' }, [
          el('span', { class: 'who', text: who }),
          q.text
        ]));
      });
    } else {
      body.appendChild(el('p', { class: 'source-empty', text: '这张卡还没有来源引文。' }));
    }
    if (card.crossProject && card.crossProject.length) {
      body.appendChild(el('p', { class: 'source-cross' }, [
        el('span', { class: 'source-cross-label', text: '也出现在' }),
        card.crossProject.join(' · ')
      ]));
    }
    details.appendChild(body);
    return details;
  }

  /* ── 卡背小测 ─────────────────────────────────────────── */

  function renderBoundary(card) {
    var boundary = card.boundary;
    var wrap = el('div', { class: 'mini' });
    var options = el('div', { class: 'mini-opts' });
    var feedback = el('div', { class: 'mini-feedback' });
    var key = 'boundary:' + card.id;
    var answerIndex = Number(boundary.answerIndex);
    var valid = answerIndex >= 0 && answerIndex < boundary.options.length;

    wrap.appendChild(el('p', { class: 'mini-q', text: boundary.q || '换一个条件，它还成立吗？' }));
    boundary.options.forEach(function (text, i) {
      options.appendChild(el('button', {
        class: 'mini-opt',
        type: 'button',
        'data-index': i,
        on: {
          click: function () {
            state.mini[key] = i;
            paint();
          }
        }
      }, [
        el('span', { class: 'key', text: letter(i) }),
        el('span', { class: 'txt', text: text })
      ]));
    });
    wrap.appendChild(options);
    wrap.appendChild(feedback);

    function paint() {
      var picked = state.mini[key];
      var answered = isAnswered(picked);
      Array.prototype.forEach.call(options.children, function (btn, i) {
        btn.className = 'mini-opt';
        if (!answered) return;
        if (valid && i === answerIndex) btn.classList.add('is-right');
        if (valid && i === picked && i !== answerIndex) btn.classList.add('is-wrong');
        if (valid && i !== picked && i !== answerIndex) btn.classList.add('is-muted');
        if (i === picked) btn.classList.add('is-picked');
      });
      if (!answered) {
        feedback.className = 'mini-feedback';
        feedback.textContent = '';
        return;
      }
      if (!valid) {
        feedback.className = 'mini-feedback bad';
        feedback.textContent = '这道边界题的数据有点问题，先跳过。';
        return;
      }
      var ok = picked === answerIndex;
      feedback.className = 'mini-feedback ' + (ok ? 'ok' : 'bad');
      feedback.textContent = (ok ? '对。' : '不是这个——正确答案是「' + boundary.options[answerIndex] + '」。') +
        (boundary.explain ? ' ' + boundary.explain : '');
    }

    paint();
    return wrap;
  }

  function renderCardQuizList(card) {
    var wrap = el('div', { class: 'mini-list' });
    card.quiz.forEach(function (quiz, index) {
      wrap.appendChild(renderMiniQuiz(card, quiz, index));
    });
    return wrap;
  }

  function renderMiniQuiz(card, quiz, index) {
    var key = 'quiz:' + card.id + ':' + index;
    var answerIndex = Number(quiz.answerIndex);
    var valid = answerIndex >= 0 && answerIndex < (quiz.options || []).length;
    var options = el('div', { class: 'mini-opts' });
    var feedback = el('div', { class: 'mini-feedback' });
    var wrap = el('div', { class: 'mini' });

    wrap.appendChild(el('div', { class: 'mini-head' }, [
      el('span', { class: 'mini-kind', text: QUIZ_KIND[quiz.kind] || '变式' }),
      el('span', { class: 'mini-index', text: '变式 ' + (index + 1) })
    ]));
    wrap.appendChild(el('p', { class: 'mini-q', text: quiz.q || '' }));

    (quiz.options || []).forEach(function (text, i) {
      options.appendChild(el('button', {
        class: 'mini-opt',
        type: 'button',
        'data-index': i,
        on: {
          click: function () {
            state.mini[key] = i;
            paint();
          }
        }
      }, [
        el('span', { class: 'key', text: letter(i) }),
        el('span', { class: 'txt', text: text })
      ]));
    });
    wrap.appendChild(options);
    wrap.appendChild(feedback);

    function paint() {
      var picked = state.mini[key];
      var answered = isAnswered(picked);
      Array.prototype.forEach.call(options.children, function (btn, i) {
        btn.className = 'mini-opt';
        if (!answered) return;
        if (valid && i === answerIndex) btn.classList.add('is-right');
        if (valid && i === picked && i !== answerIndex) btn.classList.add('is-wrong');
        if (valid && i !== picked && i !== answerIndex) btn.classList.add('is-muted');
        if (i === picked) btn.classList.add('is-picked');
      });
      if (!answered) {
        feedback.className = 'mini-feedback';
        feedback.textContent = '';
        return;
      }
      if (!valid) {
        feedback.className = 'mini-feedback bad';
        feedback.textContent = '这道变式题的数据有点问题，先跳过。';
        return;
      }
      var ok = picked === answerIndex;
      feedback.className = 'mini-feedback ' + (ok ? 'ok' : 'bad');
      feedback.textContent = (ok ? '对。' : '不是这个，正确选项已标出。') +
        (quiz.explain ? ' ' + quiz.explain : '');
    }

    paint();
    return wrap;
  }

  /* ── 图型 ─────────────────────────────────────────────── */

  function makeSvg(height, label) {
    var svg = sv('svg', {
      viewBox: '0 0 ' + FIG_W + ' ' + height,
      role: 'img',
      'aria-label': label || '示意图',
      class: 'fig-svg'
    });
    svg.__figId = 'fig' + (++figSeq);
    var title = sv('title');
    title.textContent = label || '示意图';
    svg.appendChild(title);
    return svg;
  }

  function renderFigureBlock(figure) {
    var svg = buildFigure(figure);
    if (!svg) return null;
    var fig = el('figure', { class: 'figure' }, [svg]);
    if (figure.caption) fig.appendChild(el('figcaption', { text: figure.caption }));
    return fig;
  }

  function buildFigure(figure) {
    if (!figure || !figure.spec) return null;
    var spec = figure.spec;
    var label = figure.alt || figure.caption || '示意图';
    switch (figure.type) {
      case 'budget-bar': return figBudgetBar(spec, label);
      case 'timeline': return figTimeline(spec, label);
      case 'state': return figState(spec, label);
      case 'tree': return figTree(spec, label);
      case 'branch': return figBranch(spec, label);
      case 'code-diff': return figCodeDiff(spec, label);
      case 'compare': return figCompare(spec, label);
      default: return null;
    }
  }

  function figBudgetBar(spec, label) {
    var total = Math.max(1, Number(spec.total) || 1);
    var segments = Array.isArray(spec.segments) ? spec.segments : [];
    var used = spec.used != null ? Number(spec.used) : segments.reduce(function (sum, s) {
      return sum + (Number(s.value) || 0);
    }, 0);
    var height = 122;
    var svg = makeSvg(height, label);
    var x = 8;
    var y = 36;
    var w = FIG_W - 16;
    var h = 26;

    var segmentSum = segments.reduce(function (sum, seg) {
      return sum + Math.max(0, Number(seg.value) || 0);
    }, 0);
    var usedMatches = spec.used != null && Math.abs(used - segmentSum) < 0.5;
    txt(svg, x, 18, '总预算 ' + total, { size: 13.5, fill: C.ink3 });
    txt(svg, x + w, 18, usedMatches ? '已用 ' + used : '分段合计 ' + segmentSum, {
      size: 13.5, fill: C.ink3, anchor: 'end'
    });
    rect(svg, x, y, w, h, { fill: C.paper2, rx: 5 });

    var colors = [C.band, C.band2, C.band3, C.band3];
    var cursor = 0;
    segments.forEach(function (seg, i) {
      var value = Math.max(0, Number(seg.value) || 0);
      var width = Math.min(w - cursor, value / total * w);
      if (width > 0) {
        rect(svg, x + cursor, y, width, h, {
          fill: colors[i % colors.length],
          rx: i === 0 ? 5 : 2
        });
        if (width > 104) {
          txt(svg, x + cursor + width / 2, y + 17.5, (seg.label || '') + ' ' + value, {
            size: 14, fill: C.ink2, anchor: 'middle'
          });
        } else {
          txt(svg, x + cursor + width / 2, y + h + 17, (seg.label || '') + ' ' + value, {
            size: 12, fill: C.ink3, anchor: 'middle'
          });
        }
      } else {
        line(svg, x + cursor, y - 2, x + cursor, y + h + 2, { stroke: C.accent, width: 2 });
        txt(svg, x + cursor - 4, y + h + 17, (seg.label || '') + ' 0', {
          size: 12, fill: C.accent, anchor: 'end'
        });
      }
      cursor += width;
    });

    txt(svg, x, height - 9, '剩余 ' + Math.max(0, total - segmentSum), { size: 12.5, fill: C.ink3 });
    if (!usedMatches && spec.used != null) {
      txt(svg, x + w, height - 9, '其中已用 ' + used, { size: 12.5, fill: C.ink3, anchor: 'end' });
    }
    return svg;
  }

  function figTimeline(spec, label) {
    var steps = Array.isArray(spec.steps) ? spec.steps : [];
    var prepared = steps.map(function (step) {
      return {
        label: wrapText(step.label || '', 22, 1)[0] || '',
        details: wrapText(step.detail || '', 28, 3)
      };
    });
    if (!prepared.length) prepared.push({ label: '', details: [''] });

    var rowHeights = prepared.map(function (step) {
      return Math.max(50, 22 + 16 + step.details.length * 15 + 6);
    });
    var height = 16 + rowHeights.reduce(function (sum, h) { return sum + h; }, 0) + 8;
    var svg = makeSvg(height, label);
    var lineX = 18;
    var cursor = 16;
    var centers = [];

    prepared.forEach(function (step, i) {
      centers.push(cursor + 13);
      cursor += rowHeights[i];
    });

    line(svg, lineX, centers[0], lineX, centers[centers.length - 1], {
      stroke: C.line2, width: 1
    });

    prepared.forEach(function (step, i) {
      var centerY = centers[i];
      var isLast = i === prepared.length - 1;
      circle(svg, lineX, centerY, 10.5, {
        fill: isLast ? C.accentSoft : C.card,
        stroke: isLast ? C.accent : C.line2
      });
      txt(svg, lineX, centerY + 4, String(i + 1), {
        size: 11.5,
        fill: isLast ? C.accent : C.ink3,
        anchor: 'middle'
      });
      txt(svg, lineX + 24, centerY + 4, step.label, {
        size: 15, fill: C.ink2
      });
      step.details.forEach(function (lineText, li) {
        txt(svg, lineX + 24, centerY + 24 + li * 15, lineText, {
          size: 13.5, fill: C.ink3
        });
      });
    });

    return svg;
  }

  function figState(spec, label) {
    var nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
    var edges = Array.isArray(spec.edges) ? spec.edges : [];
    var n = Math.max(1, nodes.length);
    var gap = 30;
    var nodeH = 44;
    var nodeW = Math.min(112, (FIG_W - 28 - gap * (n - 1)) / n);
    var totalW = nodeW * n + gap * (n - 1);
    var startX = (FIG_W - totalW) / 2;

    var pos = {};
    var names = {};
    nodes.forEach(function (node, i) {
      var x = startX + i * (nodeW + gap);
      pos[node.id] = { x: x, y: 0, w: nodeW, h: nodeH, cx: x + nodeW / 2, index: i };
      names[node.id] = node.label || node.id;
    });

    var valid = [];
    var above = [];
    var below = [];
    edges.forEach(function (edge) {
      var a = pos[edge.from];
      var b = pos[edge.to];
      if (!a || !b || a === b) return;
      var item = { edge: edge, a: a, b: b, forward: b.cx >= a.cx };
      valid.push(item);
      (item.forward ? above : below).push(item);
    });

    var rowY = 24 + above.length * 30;
    var belowY = rowY + nodeH + (below.length ? 26 : 0);

    // 图例：每条边一行，用编号代替压在连线上的文字
    var items = [];
    valid.forEach(function (item) {
      var head = (valid.indexOf(item) + 1) + '\u3000' + names[item.edge.from] + ' \u2192 ' + names[item.edge.to] + '\uff1a' + (item.edge.label || '');
      items.push(wrapText(head, 34, 2));
    });
    var legendY = below.length ? belowY + (below.length - 1) * 30 + 30 : rowY + nodeH + 26;
    var legendH = items.reduce(function (sum, lines) { return sum + lines.length * 14 + 4; }, 0);
    var height = legendY + legendH + 12;

    var svg = makeSvg(height, label);
    var arrowId = (svg.__figId || 'fig') + '-arrow';

    function drawEdge(item, lane) {
      var a = item.a;
      var b = item.b;
      var edgeY = item.forward ? rowY + 2 : rowY + nodeH - 2;
      var controlY = item.forward
        ? rowY - 22 - lane * 30
        : rowY + nodeH + 22 + lane * 30;
      var ctrlX = (a.cx + b.cx) / 2;
      var d = 'M ' + a.cx + ' ' + edgeY + ' Q ' + ctrlX + ' ' + controlY + ' ' + b.cx + ' ' + edgeY;
      path(svg, d, { stroke: C.line2, width: 1.2, marker: 'url(#' + arrowId + ')' });
      var badgeX = 0.25 * a.cx + 0.5 * ctrlX + 0.25 * b.cx;
      var badgeY = 0.25 * edgeY + 0.5 * controlY + 0.25 * edgeY;
      svg.appendChild(sv('circle', {
        cx: badgeX, cy: badgeY, r: 7.5, fill: C.card, stroke: C.line2, 'stroke-width': 1
      }));
      txt(svg, badgeX, badgeY + 3.4, String(valid.indexOf(item) + 1), {
        size: 9, fill: C.ink3, anchor: 'middle'
      });
    }

    var ai = 0;
    var bi = 0;
    valid.forEach(function (item) {
      drawEdge(item, item.forward ? ai++ : bi++);
    });

    nodes.forEach(function (node) {
      var item = pos[node.id];
      rect(svg, item.x, rowY, nodeW, nodeH, { fill: C.card, stroke: C.line2, rx: 7 });
      var lines = wrapText(names[node.id], 6, 2);
      var firstY = rowY + nodeH / 2 + 4 - (lines.length - 1) * 8;
      lines.forEach(function (lineText, li) {
        txt(svg, item.cx, firstY + li * 16, lineText, {
          size: 12.5, fill: C.ink2, anchor: 'middle'
        });
      });
    });

    var ly = legendY;
    items.forEach(function (lines) {
      lines.forEach(function (lineText, li) {
        txt(svg, 8, ly + 10 + li * 14, lineText, {
          size: 10.5, fill: C.ink3, anchor: 'start'
        });
      });
      ly += lines.length * 14 + 4;
    });

    var defs = sv('defs');
    var marker = sv('marker', {
      id: arrowId, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto'
    });
    marker.appendChild(sv('path', { d: 'M0 0 L6 3.5 L0 7', fill: C.line2 }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    return svg;
  }

  function figTree(spec, label) {
    var root = spec.root || {};
    var children = Array.isArray(root.children) ? root.children : [];
    var rootLines = wrapText(root.label || '', 24, 2);
    var rootH = 16 + rootLines.length * 18;
    var childData = children.map(function (child) {
      return wrapText(child.label || '', 26, 2);
    });
    var rows = childData.map(function (lines) {
      return Math.max(34, 10 + lines.length * 17);
    });
    var height = 34 + rootH + rows.reduce(function (sum, h) { return sum + h; }, 0) + 14;
    var svg = makeSvg(height, label);
    var rootX = 8;
    var rootY = 8;
    var rootW = Math.min(300, Math.max(170, 22 + (rootLines[0] || '').length * 13.5));
    var spineX = rootX + 20;
    var spineTop = rootY + rootH + 8;
    var bottom = height - 10;

    rect(svg, rootX, rootY, rootW, rootH, {
      fill: C.paper2, stroke: C.line2, rx: 5
    });
    rootLines.forEach(function (lineText, i) {
      txt(svg, rootX + 12, rootY + 22 + i * 18, lineText, {
        size: 15, fill: C.ink2
      });
    });

    line(svg, spineX, spineTop, spineX, bottom, { stroke: C.line2, width: 1 });

    var cursor = spineTop + 12;
    children.forEach(function (child, i) {
      var centerY = cursor + 8;
      line(svg, spineX, centerY, spineX + 14, centerY, { stroke: C.line2, width: 1 });
      circle(svg, spineX + 18, centerY, 2.6, { fill: C.accent, stroke: C.accent });
      childData[i].forEach(function (lineText, li) {
        txt(svg, spineX + 30, centerY + 5 + li * 16, lineText, {
          size: 13.5, fill: C.ink2
        });
      });
      cursor += rows[i];
    });

    return svg;
  }

  function figBranch(spec, label) {
    var height = 200;
    var svg = makeSvg(height, label);
    var arrowId = (svg.__figId || 'fig') + '-arrow';
    var qText = spec.question || '';
    var qLines = wrapText(qText, 19, 2);
    var qH = 22 + qLines.length * 18;
    var qW = 306;
    var qX = (FIG_W - qW) / 2;
    var qY = 8;

    rect(svg, qX, qY, qW, qH, { fill: C.card, stroke: C.line2, rx: 7 });
    qLines.forEach(function (lineText, i) {
      txt(svg, FIG_W / 2, qY + 24 + i * 18, lineText, {
        size: 15, fill: C.ink2, anchor: 'middle'
      });
    });

    var boxW = 178;
    var boxH = 72;
    var boxY = 116;
    var leftX = 20;
    var rightX = FIG_W - 20 - boxW;
    var leftCx = leftX + boxW / 2;
    var rightCx = rightX + boxW / 2;
    var branchFromY = qY + qH;
    var qCx = FIG_W / 2;

    path(svg, 'M ' + qCx + ' ' + branchFromY + ' C ' + qCx + ' ' + (branchFromY + 22) +
      ' ' + leftCx + ' ' + (boxY - 26) + ' ' + leftCx + ' ' + boxY, {
      stroke: C.line2, width: 1.2, marker: 'url(#' + arrowId + ')'
    });
    path(svg, 'M ' + qCx + ' ' + branchFromY + ' C ' + qCx + ' ' + (branchFromY + 22) +
      ' ' + rightCx + ' ' + (boxY - 26) + ' ' + rightCx + ' ' + boxY, {
      stroke: C.line2, width: 1.2, marker: 'url(#' + arrowId + ')'
    });
    txt(svg, leftCx, boxY - 18, '是', { size: 12, fill: C.ink3, anchor: 'middle' });
    txt(svg, rightCx, boxY - 18, '否', { size: 12, fill: C.ink3, anchor: 'middle' });

    [{
      x: leftX,
      data: spec.yes || {},
      tone: 'ok'
    }, {
      x: rightX,
      data: spec.no || {},
      tone: 'warn'
    }].forEach(function (box) {
      rect(svg, box.x, boxY, boxW, boxH, {
        fill: box.tone === 'ok' ? C.okSoft : C.accentSoft,
        stroke: box.tone === 'ok' ? C.ok : C.accent,
        rx: 7
      });
      var lines = wrapText(box.data.label || '', 11, 3);
      lines.forEach(function (lineText, i) {
        txt(svg, box.x + boxW / 2, boxY + 25 + i * 17, lineText, {
          size: 13.5,
          fill: box.tone === 'ok' ? C.ok : C.accent,
          anchor: 'middle'
        });
      });
    });

    var defs = sv('defs');
    var marker = sv('marker', {
      id: arrowId, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3.5, orient: 'auto'
    });
    marker.appendChild(sv('path', { d: 'M0 0 L6 3.5 L0 7', fill: C.line2 }));
    defs.appendChild(marker);
    svg.appendChild(defs);
    return svg;
  }

  function figCodeDiff(spec, label) {
    var lines = Array.isArray(spec.lines) ? spec.lines : [];
    var rows = [];
    var maxChars = 45;

    lines.forEach(function (entry, i) {
      var chunks = splitCode(entry.text || '', maxChars);
      chunks.forEach(function (chunk, ci) {
        rows.push({
          no: entry.no == null ? i + 1 : entry.no,
          text: chunk,
          mark: entry.mark || 'same',
          first: ci === 0
        });
      });
    });

    var height = 36 + rows.length * 24 + 10;
    var svg = makeSvg(height, label);
    if (spec.file) {
      txt(svg, 8, 17, spec.file, { size: 12, fill: C.ink3, mono: true });
    }

    rows.forEach(function (row, i) {
      var y = 30 + i * 24;
      var mark = row.mark;
      if (mark === 'add' || mark === 'del') {
        rect(svg, 8, y, FIG_W - 16, 22, {
          fill: mark === 'add' ? C.okSoft : C.accentSoft,
          rx: 3
        });
      } else {
        rect(svg, 8, y, FIG_W - 16, 22, { fill: C.paper2, rx: 3 });
      }
      if (row.first) {
        txt(svg, 36, y + 15, String(row.no), {
          size: 12, fill: C.ink3, mono: true, anchor: 'end'
        });
        var sign = mark === 'add' ? '+' : (mark === 'del' ? '−' : ' ');
        txt(svg, 46, y + 15, sign, {
          size: 14,
          fill: mark === 'add' ? C.ok : (mark === 'del' ? C.accent : C.ink3),
          mono: true
        });
      } else {
        txt(svg, 46, y + 15, '↳', { size: 11, fill: C.ink3, mono: true });
      }
      txt(svg, 60, y + 15.5, row.text, {
        size: 12.8, fill: mark === 'del' ? C.accent : C.ink2, mono: true
      });
    });

    return svg;
  }

  function splitCode(text, maxChars) {
    var chars = Array.from(String(text || ''));
    var chunks = [];
    while (chars.length > maxChars) {
      var window = chars.slice(0, maxChars);
      var breakAt = -1;
      for (var i = window.length - 1; i > Math.floor(maxChars * 0.55); i--) {
        if (window[i] === ' ') { breakAt = i; break; }
      }
      if (breakAt > 0) {
        chunks.push(chars.slice(0, breakAt).join(''));
        chars = chars.slice(breakAt + 1);
      } else {
        chunks.push(window.join(''));
        chars = chars.slice(maxChars);
      }
    }
    chunks.push(chars.join(''));
    return chunks.length ? chunks : [''];
  }

  function figCompare(spec, label) {
    var height = 158;
    var svg = makeSvg(height, label);
    var boxW = 188;
    var boxH = 98;
    var y = 34;
    var left = spec.left || {};
    var right = spec.right || {};
    var gap = 14;
    var leftX = (FIG_W - (boxW * 2 + gap)) / 2;
    var rightX = leftX + boxW + gap;

    txt(svg, 8, 18, '两个做法并排看', { size: 12.5, fill: C.ink3 });

    [{
      x: leftX,
      data: left,
      tone: 'left'
    }, {
      x: rightX,
      data: right,
      tone: 'right'
    }].forEach(function (box) {
      rect(svg, box.x, y, boxW, boxH, {
        fill: box.tone === 'right' ? C.okSoft : C.card,
        stroke: box.tone === 'right' ? C.ok : C.line2,
        rx: 7
      });
      var labelLines = wrapText(box.data.label || '', 11, 2);
      labelLines.forEach(function (lineText, i) {
        txt(svg, box.x + boxW / 2, y + 32 + i * 18, lineText, {
          size: 15,
          fill: box.tone === 'right' ? C.ok : C.ink2,
          anchor: 'middle'
        });
      });
      var costLines = wrapText(box.data.cost || '', 13, 2);
      costLines.forEach(function (lineText, i) {
        txt(svg, box.x + boxW / 2, y + 68 + i * 16, lineText, {
          size: 12.5, fill: C.ink3, anchor: 'middle'
        });
      });
    });

    txt(svg, FIG_W / 2, y + boxH / 2 + 4, '对', {
      size: 12, fill: C.accent, anchor: 'middle'
    });

    return svg;
  }

  /* ── 答题 ─────────────────────────────────────────────── */

  function renderQuiz() {
    var quiz = ensureQuiz(false);
    var wrap = el('section', { class: 'view view-quiz' });
    wrap.appendChild(renderHero({
      kicker: '02 / 答题',
      title: '一次只答一道',
      lede: '选完立刻知道对错。这一轮答完就结束，不留作业。',
      note: '题目是卡片背面的变式题，不是正面原题换皮。答错的那道，解释会留在下面。'
    }));

    if (!quiz.items.length) {
      wrap.appendChild(emptyPanel('还没有变式题。', '卡片工厂给了题以后，这里会排成队列。'));
      return wrap;
    }

    if (quiz.done) {
      wrap.appendChild(renderQuizResult());
    } else {
      wrap.appendChild(renderQuizQuestion());
    }
    return wrap;
  }

  function renderQuizQuestion() {
    var quiz = ensureQuiz(false);
    var item = quiz.items[quiz.index];
    var total = quiz.items.length;
    var key = quizKey(item);
    var answered = quiz.answers[key];
    var stage = el('div', { class: 'quiz-stage' });

    var pct = Math.round((quiz.index + 1) / total * 100);
    stage.appendChild(el('div', { class: 'quiz-progressbar' }, [
      el('span', { style: 'width:' + pct + '%' })
    ]));

    var options = el('div', { class: 'options quiz-options' });
    var feedback = el('div', { class: 'quiz-explain', hidden: true });

    var nextBtn = el('button', {
      class: 'btn btn-primary quiz-next',
      type: 'button',
      hidden: !answered,
      on: {
        click: function () {
          quiz.index += 1;
          if (quiz.index >= quiz.items.length) {
            quiz.index = quiz.items.length - 1;
            quiz.done = true;
            render();
            window.requestAnimationFrame(function () {
              var end = $('.quiz-end');
              if (end) scrollIntoViewSafe(end, 'center');
            });
          } else {
            render();
            window.requestAnimationFrame(function () {
              var card = $('#quiz-card');
              if (card) scrollIntoViewSafe(card, 'start');
            });
          }
        }
      }
    }, quiz.index + 1 >= total ? '看结果' : '下一题');

    (item.quiz.options || []).forEach(function (text, i) {
      options.appendChild(el('button', {
        class: 'option quiz-option',
        type: 'button',
        'data-index': i,
        disabled: !!answered,
        on: {
          click: function () {
            if (quiz.answers[key]) return;
            var correct = Number(item.quiz.answerIndex) === i;
            quiz.answers[key] = { picked: i, correct: correct };
            paintQuizOptions();
            postJSON('/api/quiz', {
              cardId: item.card.id,
              quizIndex: item.quizIndex,
              picked: i
            });
          }
        }
      }, [
        el('span', { class: 'key', text: letter(i) }),
        el('span', { class: 'txt', text: text }),
        el('span', { class: 'mark' })
      ]));
    });

    var card = el('div', { class: 'quiz-card', id: 'quiz-card' }, [
      el('div', { class: 'quiz-top' }, [
        el('span', { class: 'quiz-kind', text: QUIZ_KIND[item.quiz.kind] || '变式' }),
        el('span', { class: 'quiz-progress', text: '第 ' + (quiz.index + 1) + ' / ' + total + ' 题' })
      ]),
      el('p', { class: 'quiz-source', text: '来自「' + item.card.title + '」' }),
      el('p', { class: 'quiz-q', text: item.quiz.q || '' }),
      options,
      feedback,
      el('div', { class: 'quiz-actions' }, [nextBtn])
    ]);

    stage.appendChild(card);
    paintQuizOptions();

    function paintQuizOptions() {
      var answer = quiz.answers[key];
      Array.prototype.forEach.call(options.children, function (btn, i) {
        btn.className = 'option quiz-option';
        btn.disabled = !!answer;
        if (!answer) return;
        var isCorrect = Number(item.quiz.answerIndex) === i;
        if (isCorrect) btn.classList.add('is-right');
        if (i === answer.picked && !isCorrect) btn.classList.add('is-wrong');
        if (i !== answer.picked && !isCorrect) btn.classList.add('is-muted');
        var mark = btn.querySelector('.mark');
        if (isCorrect) mark.textContent = '对';
        else if (i === answer.picked) mark.textContent = '不是这个';
      });
      if (answer) {
        feedback.hidden = false;
        feedback.className = 'quiz-explain ' + (answer.correct ? 'ok' : 'bad');
        feedback.textContent = (answer.correct ? '对。' : '不是这个，正确选项已经标出。') +
          (item.quiz.explain ? ' ' + item.quiz.explain : '');
        nextBtn.hidden = false;
      }
    }

    return stage;
  }

  function renderQuizResult() {
    var quiz = ensureQuiz(false);
    var total = quiz.items.length;
    var correct = quiz.items.reduce(function (sum, item) {
      var answer = quiz.answers[quizKey(item)];
      return sum + (answer && answer.correct ? 1 : 0);
    }, 0);

    return el('div', { class: 'quiz-stage' }, [
      el('div', { class: 'quiz-end' }, [
        el('div', { class: 'kicker' }, '这一轮'),
        el('p', { class: 'quiz-score' }, [
          el('span', { class: 'score-label', text: '本轮' }),
          el('b', { text: correct }),
          el('span', { class: 'score-sep', text: '/' }),
          el('span', { text: total })
        ]),
        el('p', { class: 'quiz-end-note' }, '错的那几道，卡片背面都写着为什么。'),
        el('div', { class: 'quiz-end-actions' }, [
          el('button', {
            class: 'btn btn-primary',
            type: 'button',
            on: {
              click: function () {
                ensureQuiz(true);
                render();
                window.requestAnimationFrame(function () {
                  var card = $('#quiz-card');
                  if (card) scrollIntoViewSafe(card, 'start');
                });
              }
            }
          }, '再来一轮'),
          el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            on: { click: function () { go('#deck'); } }
          }, '回卡片流')
        ])
      ])
    ]);
  }

  /* ── 地图 ─────────────────────────────────────────────── */

  function renderMap() {
    var wrap = el('section', { class: 'view view-map' });
    wrap.appendChild(renderHero({
      kicker: '03 / 概念地图',
      title: '图只画概念，不画卡片',
      lede: '点一个节点，只看它周围一跳：它是什么、你讲到哪、和谁相连、在哪里出现过。',
      note: '四条边各有含义：前置、因果、对比、同源。写不出理由的边，不画。'
    }));

    if (!state.bundle.concepts.length) {
      wrap.appendChild(emptyPanel('还没有概念。', '先有卡片，概念才会长出来。'));
      return wrap;
    }

    var focus = state.mapFocus && state.bundle.conceptMap[state.mapFocus] ? state.mapFocus : null;
    if (state.mapFocus !== focus) state.mapFocus = focus;

    var tools = [renderLegend()];
    if (focus) {
      tools.push(el('button', {
        class: 'btn btn-quiet',
        type: 'button',
        on: { click: function () { go('#map'); } }
      }, '看全部'));
    } else {
      tools.push(el('span', { class: 'map-hint', text: '点一个节点，只看它的一跳' }));
    }
    wrap.appendChild(el('div', { class: 'map-tools' }, tools));

    var canvas = el('div', { class: 'map-canvas', id: 'map-canvas' });
    var seen = {};
    state.bundle.concepts.forEach(function (concept) {
      var domain = concept.domain || '未分簇';
      if (!seen[domain]) {
        seen[domain] = true;
        canvas.appendChild(el('div', {
          class: 'map-band',
          'data-domain': domain,
          style: 'top:0px'
        }, el('span', { text: domain })));
      }
    });
    state.bundle.concepts.forEach(function (concept) {
      canvas.appendChild(el('button', {
        class: 'map-node',
        type: 'button',
        'data-concept': concept.id,
        title: (concept.problem ? concept.problem + ' · ' : '') + concept.desc,
        on: {
          click: function (ev) {
            ev.stopPropagation();
            go('#map/' + encodeURIComponent(concept.id));
          },
          mouseenter: function () { highlightMapHover(concept.id, true); },
          mouseleave: function () { highlightMapHover(concept.id, false); }
        }
      }, el('span', { text: concept.name })));
    });
    canvas.appendChild(sv('svg', { class: 'map-edges' }));

    var frame = el('div', { class: 'map-frame' }, canvas);
    frame.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.map-node')) return;
      if (state.mapFocus) go('#map');
    });

    wrap.appendChild(el('div', { class: 'map-layout' }, [
      frame,
      renderConceptDetail(focus)
    ]));

    return wrap;
  }

  function renderLegend() {
    return el('div', { class: 'legend' }, Object.keys(KIND).map(function (kind) {
      return el('span', { class: 'legend-item' }, [
        el('i', { class: 'legend-line k-' + kind }),
        el('span', { class: 'legend-name', text: KIND[kind].name }),
        el('span', { class: 'legend-desc', text: KIND[kind].line })
      ]);
    }));
  }

  function renderConceptDetail(focus) {
    var concept = focus && state.bundle.conceptMap[focus];
    if (!concept) {
      return el('aside', { class: 'concept-detail concept-detail-empty' }, [
        el('div', { class: 'kicker' }, '怎么读这张图'),
        el('h2', { class: 'detail-title', text: '先点一个节点' }),
        el('p', { class: 'detail-desc', text: '点下去，只亮它一跳的邻居；聚焦之后，点「看全部」或画布空白处，回到整张网。' }),
        el('p', { class: 'detail-empty' }, '节点是概念，不是卡片。连线只有四种：前置、因果、对比、同源。'),
        el('p', { class: 'detail-empty' }, '每个概念下面挂着它出现过的卡片，点标题就能翻背面。')
      ]);
    }

    var rels = state.bundle.edges.filter(function (edge) {
      return edge.from === focus || edge.to === focus;
    });
    var cards = state.bundle.cards.filter(function (card) {
      return card.conceptId === focus;
    });

    var ri = rungInfo(focus);
    var stText = ri.state === 'known' ? '已会' : ri.state === 'practicing' ? '在练' : ri.state === 'taught' ? '讲过' : '没开始';
    var dots = el('span', { class: 'dots' });
    for (var i = 0; i < 5; i++) {
      dots.appendChild(el('i', { class: i <= ri.rung ? 'on' : '' }));
    }

    var detail = el('aside', { class: 'concept-detail' }, [
      el('div', { class: 'detail-crumb' }, [
        concept.domain,
        concept.problem ? el('span', { class: 'crumb-sep', text: ' / ' }) : null,
        concept.problem || null
      ]),
      el('h2', { class: 'detail-title', text: concept.name }),
      el('p', { class: 'detail-desc', text: concept.desc }),
      el('div', { class: 'mastery' }, [
        dots,
        el('span', { class: 'mastery-label', text: 'G' + ri.rung + ' · ' + ri.name + ' · ' + stText })
      ])
    ]);

    var relList = el('ul', { class: 'rel-list' });
    if (rels.length) {
      rels.forEach(function (edge) {
        var otherId = edge.from === focus ? edge.to : edge.from;
        var other = state.bundle.conceptMap[otherId];
        if (!other) return;
        var directed = edge.kind === 'prereq' || edge.kind === 'cause';
        var dir = '';
        if (directed) dir = edge.from === focus ? '→' : '←';
        relList.appendChild(el('li', {}, [
          el('div', { class: 'rel-head' }, [
            el('span', { class: 'rel-kind k-' + edge.kind, text: KIND[edge.kind].name }),
            dir ? el('span', { class: 'rel-dir', text: dir }) : null,
            el('button', {
              class: 'rel-other',
              type: 'button',
              on: { click: function () { go('#map/' + encodeURIComponent(otherId)); } }
            }, other.name)
          ]),
          el('span', { class: 'rel-reason', text: edge.reason || '没有写理由。' })
        ]));
      });
    } else {
      relList.appendChild(el('li', { class: 'rel-empty', text: '还没有连边。没理由的边不建。' }));
    }
    detail.appendChild(el('div', { class: 'detail-h' }, '连着的边'));
    detail.appendChild(relList);

    detail.appendChild(el('div', { class: 'detail-h' }, '这个概念下的卡片'));
    if (cards.length) {
      detail.appendChild(el('div', { class: 'detail-cards' }, cards.map(function (card) {
        return el('button', {
          class: 'detail-card',
          type: 'button',
          on: { click: function () { go('#deck/' + encodeURIComponent(card.id)); } }
        }, [
          el('span', { class: 'dc-title', text: card.title }),
          el('span', { class: 'dc-lane', text: laneName(card.lane) })
        ]);
      })));
    } else {
      detail.appendChild(el('p', { class: 'detail-empty', text: '这个概念还没有卡片。' }));
    }

    return detail;
  }

  function layoutMap() {
    var canvas = $('#map-canvas');
    if (!canvas) return;
    var width = canvas.clientWidth;
    if (width < 200) {
      canvas.__mapTries = (canvas.__mapTries || 0) + 1;
      if (canvas.__mapTries < 12) window.requestAnimationFrame(layoutMap);
      return;
    }

    var concepts = state.bundle.concepts;
    var edges = state.bundle.edges;
    var focus = state.mapFocus && state.bundle.conceptMap[state.mapFocus] ? state.mapFocus : null;

    var pad = 16;
    var gapX = 12;
    var gapY = 12;
    var nodeH = 38;
    var labelH = 56;
    var bandGap = 14;
    var minW = 132;
    var maxW = 196;
    var cols = Math.max(2, Math.min(4, Math.floor((width - pad * 2 + gapX) / (minW + gapX))));

    var domains = [];
    concepts.forEach(function (concept) {
      var domain = concept.domain || '未分簇';
      if (domains.indexOf(domain) === -1) domains.push(domain);
    });

    var positions = {};
    var bandTops = {};
    var y = pad;

    domains.forEach(function (domain) {
      var items = concepts.filter(function (concept) { return (concept.domain || '未分簇') === domain; });
      var rows = Math.ceil(items.length / cols);
      var nodeW = Math.min(maxW, (width - pad * 2 - (cols - 1) * gapX) / cols);
      bandTops[domain] = y;
      items.forEach(function (concept, i) {
        var col = i % cols;
        var row = Math.floor(i / cols);
        var countInRow = Math.min(cols, items.length - row * cols);
        var totalW = countInRow * nodeW + (countInRow - 1) * gapX;
        var startX = (width - totalW) / 2;
        positions[concept.id] = {
          x: startX + col * (nodeW + gapX),
          y: y + labelH + row * (nodeH + gapY),
          w: nodeW,
          h: nodeH
        };
      });
      y += labelH + rows * nodeH + Math.max(0, rows - 1) * gapY + bandGap;
    });

    var height = Math.max(180, y - bandGap + pad);
    canvas.style.height = height + 'px';

    $all('.map-band', canvas).forEach(function (band) {
      band.style.top = ((bandTops[band.getAttribute('data-domain')] || 0) - 12) + 'px';
    });

    var near = {};
    if (focus) {
      near[focus] = true;
      edges.forEach(function (edge) {
        if (edge.from === focus || edge.to === focus) {
          near[edge.from] = true;
          near[edge.to] = true;
        }
      });
    }

    $all('.map-node', canvas).forEach(function (node) {
      var id = node.getAttribute('data-concept');
      var pos = positions[id];
      if (!pos) return;
      node.style.left = pos.x + 'px';
      node.style.top = pos.y + 'px';
      node.style.width = pos.w + 'px';
      node.style.height = pos.h + 'px';
      node.classList.toggle('is-active', id === focus);
      node.classList.toggle('is-near', !!near[id] && id !== focus);
      node.classList.toggle('is-dim', !!focus && !near[id]);
    });

    drawMapEdges(canvas, positions, width, height, focus);
  }

  function drawMapEdges(canvas, positions, width, height, focus) {
    var old = $('.map-edges', canvas);
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var svg = sv('svg', {
      class: 'map-edges',
      width: width,
      height: height,
      viewBox: '0 0 ' + width + ' ' + height
    });

    var defs = sv('defs');
    [['map-arrow', C.line2], ['map-arrow-hot', C.accent], ['map-arrow-cause', C.cause]].forEach(function (item) {
      var marker = sv('marker', {
        id: item[0],
        markerWidth: 7,
        markerHeight: 7,
        refX: 6,
        refY: 3.5,
        orient: 'auto'
      });
      marker.appendChild(sv('path', { d: 'M0 0 L6 3.5 L0 7', fill: item[1] }));
      defs.appendChild(marker);
    });
    svg.appendChild(defs);

    var sameLane = {};
    var sorted = state.bundle.edges.slice().sort(function (a, b) {
      var ah = focus && (a.from === focus || a.to === focus) ? 1 : 0;
      var bh = focus && (b.from === focus || b.to === focus) ? 1 : 0;
      return ah - bh;
    });

    sorted.forEach(function (edge) {
      var from = positions[edge.from];
      var to = positions[edge.to];
      if (!from || !to) return;

      var hot = !!focus && (edge.from === focus || edge.to === focus);
      var dim = !!focus && !hot;
      var fromConcept = state.bundle.conceptMap[edge.from];
      var toConcept = state.bundle.conceptMap[edge.to];
      var crossDomain = !!(fromConcept && toConcept && fromConcept.domain !== toConcept.domain);
      var route;
      if (!crossDomain) {
        if (Math.abs(from.y - to.y) < 2) {
          // 同一排：走"门拱"折线——先上到自己那条车道，横过去，再下到目标框顶。
          // 每条边一条独立车道，永不重叠，也不穿过中间的框。
          var lane = sameLane[edge.from] || 0;
          sameLane[edge.from] = lane + 1;
          var laneY = from.y - 14 - (lane % 3) * 14;
          var sx = from.x + from.w / 2;
          var ex = to.x + to.w / 2;
          route = {
            d: 'M' + sx + ' ' + from.y + ' V ' + laneY + ' H ' + ex + ' V ' + to.y
          };
        } else {
          // 跨排：直接连，靠节点自身遮挡避免穿过框体
          var s1 = boxAnchor(from, to);
          var e1 = boxAnchor(to, from);
          if (!s1 || !e1) return;
          route = { d: 'M' + s1.x + ' ' + s1.y + ' L' + e1.x + ' ' + e1.y };
        }
      } else {
        route = edgeRoute(from, to, width, edge.from + '>' + edge.to, crossDomain);
      }
      if (!route) return;

      var directed = edge.kind === 'prereq' || edge.kind === 'cause';
      var cls = 'medge k-' + edge.kind + (hot ? ' is-hot' : '') + (dim ? ' is-dim' : '');
      var marker = '';
      if (directed) {
        marker = hot ? 'url(#map-arrow-hot)' : (edge.kind === 'cause' ? 'url(#map-arrow-cause)' : 'url(#map-arrow)');
      }
      var edgeNode = path(svg, route.d, {
        stroke: 'none',
        width: 1.2,
        marker: marker
      });
      edgeNode.setAttribute('class', cls);
      edgeNode.setAttribute('data-from', edge.from);
      edgeNode.setAttribute('data-to', edge.to);

    });

    canvas.insertBefore(svg, canvas.firstChild);
  }

  function highlightMapHover(conceptId, on) {
    var canvas = $('#map-canvas');
    if (!canvas) return;
    $all('.map-node', canvas).forEach(function (node) {
      if (node.getAttribute('data-concept') === conceptId) node.classList.toggle('is-hover', on);
    });
    $all('.medge', canvas).forEach(function (edge) {
      if (edge.getAttribute('data-from') === conceptId || edge.getAttribute('data-to') === conceptId) {
        edge.classList.toggle('is-hover', on);
      }
    });
  }

  function boxAnchor(box, toward) {
    var cx = box.x + box.w / 2;
    var cy = box.y + box.h / 2;
    var tx = toward.x + toward.w / 2;
    var ty = toward.y + toward.h / 2;
    var dx = tx - cx;
    var dy = ty - cy;
    if (!dx && !dy) return null;
    var hw = box.w / 2 + 3;
    var hh = box.h / 2 + 3;
    var t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    if (!isFinite(t)) return null;
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function edgeRoute(from, to, width, key, crossDomain) {
    var sameRow = Math.abs(from.y - to.y) < 2;
    var fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
    var tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
    var h = hashString(key);

    if (sameRow) {
      var a = boxAnchor(from, to);
      var b = boxAnchor(to, from);
      if (!a || !b) return null;
      var lift = 34 + Math.min(28, Math.abs(b.x - a.x) * 0.05);
      var topY = Math.min(from.y, to.y) - lift;
      var d = 'M ' + a.x + ' ' + a.y +
        ' C ' + a.x + ' ' + topY + ', ' + b.x + ' ' + topY + ', ' + b.x + ' ' + b.y;
      return {
        d: d,
        label: {
          x: (a.x + b.x) / 2,
          y: Math.min(from.y, to.y) - lift * 0.75 - 6,
          anchor: 'middle'
        }
      };
    }

    var down = to.y >= from.y;
    var start = {
      x: fc.x,
      y: down ? from.y + from.h + 2 : from.y - 2
    };
    var end = {
      x: tc.x,
      y: down ? to.y - 2 : to.y + to.h + 2
    };

    if (Math.abs(to.y - from.y) > 130 || (crossDomain && Math.abs(tc.x - fc.x) > 220)) {
      var avg = (fc.x + tc.x) / 2;
      var left = avg < width / 2;
      var offset = 5 + (h % 3) * 2;
      var sideX = left ? offset : width - offset;
      var runFrom = start.y + (down ? 6 : -6);
      var runTo = end.y + (down ? -6 : 6);
      var points = [
        start,
        { x: start.x, y: runFrom },
        { x: sideX, y: runFrom },
        { x: sideX, y: runTo },
        { x: end.x, y: runTo },
        end
      ];
      return {
        d: roundedPath(points, 6),
        label: {
          x: left ? sideX + 8 : sideX - 8,
          y: (runFrom + runTo) / 2,
          anchor: left ? 'start' : 'end'
        }
      };
    }

    var dy = end.y - start.y;
    var c1y = start.y + dy * 0.45;
    var c2y = end.y - dy * 0.45;
    return {
      d: 'M ' + start.x + ' ' + start.y +
        ' C ' + start.x + ' ' + c1y + ', ' + end.x + ' ' + c2y + ', ' + end.x + ' ' + end.y,
      label: {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2 - 6,
        anchor: 'middle'
      }
    };
  }

  function roundedPath(points, radius) {
    if (!points.length) return '';
    var d = 'M ' + points[0].x + ' ' + points[0].y;
    for (var i = 1; i < points.length - 1; i++) {
      var prev = points[i - 1];
      var point = points[i];
      var next = points[i + 1];
      var v1x = prev.x - point.x;
      var v1y = prev.y - point.y;
      var v2x = next.x - point.x;
      var v2y = next.y - point.y;
      var l1 = Math.sqrt(v1x * v1x + v1y * v1y) || 1;
      var l2 = Math.sqrt(v2x * v2x + v2y * v2y) || 1;
      var r = Math.min(radius, l1 / 2, l2 / 2);
      var p1x = point.x + v1x / l1 * r;
      var p1y = point.y + v1y / l1 * r;
      var p2x = point.x + v2x / l2 * r;
      var p2y = point.y + v2y / l2 * r;
      d += ' L ' + p1x + ' ' + p1y + ' Q ' + point.x + ' ' + point.y + ' ' + p2x + ' ' + p2y;
    }
    var last = points[points.length - 1];
    d += ' L ' + last.x + ' ' + last.y;
    return d;
  }

  function hashString(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  /* ── 一条线 ───────────────────────────────────────────── */


  /* ── 知识地图：语义 / 标签 / 代码 三种看法 ───────────── */

  var kbView = { canvas: null, tip: null, hover: null, semantic: [], code: [], tag: [], files: [] };

  function renderKbMap() {
    var wrap = el('section', { class: 'view view-kbmap' });
    wrap.appendChild(renderHero({
      kicker: '05 / 知识地图',
      title: '同一个知识点，三种看法',
      lede: '标签网络看同类，代码地图看它从哪个文件长出来。',
      note: '筛选只改变“亮哪些”，不改变知识本身。点一个点，右边出详情。'
    }));

    ensureKbData(state.kbmapMode);

    var tabs = el('div', { class: 'kb-tabs', role: 'tablist' }, KB_MODES.map(function (m) {
      var on = state.kbmapMode === m.id;
      return el('button', {
        class: 'kb-tab' + (on ? ' is-on' : ''),
        type: 'button',
        role: 'tab',
        'data-mode': m.id,
        'aria-selected': on ? 'true' : 'false',
        on: { click: function () { go('#kbmap/' + m.id); } }
      }, [
        el('b', { text: m.name }),
        el('span', { text: m.hint })
      ]);
    }));
    wrap.appendChild(tabs);

    wrap.appendChild(renderKbFilters());
    wrap.appendChild(renderKbCacheStrip());
    wrap.appendChild(el('div', { class: 'kb-embed-note', id: 'kb-embed-note' }));

    var layout = el('div', { class: 'tags-layout kb-layout' });
    var card = el('div', { class: 'tags-canvas-card kb-canvas-card' });
    var cv = el('canvas', { id: 'kb-canvas', width: '900', height: '640', 'aria-label': '知识地图' });
    kbView.canvas = cv;
    kbView.tip = el('div', { class: 'tags-tip', id: 'kb-tip' });
    card.appendChild(cv);
    card.appendChild(kbView.tip);
    layout.appendChild(card);

    var side = el('aside', { class: 'tags-side kb-side', id: 'kb-side' });
    layout.appendChild(side);
    wrap.appendChild(layout);

    window.requestAnimationFrame(function () {
      bindKbCanvas();
      paintKbEmbedNote();
      renderKbSide();
      drawKbMap();
    });
    return wrap;
  }

  function ensureKbData(mode) {
    if (mode === 'semantic' && !state.kbmap && !state.kbmapLoading && !state.kbmapError) {
      state.kbmapLoading = true;
      fetch('/api/kb/map').then(function (r) {
        if (!r.ok) throw new Error('语义地图还没生成（知识缓存为空）');
        return r.json();
      }).then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.error) || '没有语义地图数据');
        state.kbmap = data;
        state.kbLogCount = Math.max(state.kbLogCount, Number(data.total) || 0);
        state.kbmapLoading = false;
        paintKbCacheCount();
        paintKbEmbedNote();
        rerenderKbFilters();
        drawKbMap();
        renderKbSide();
      }).catch(function (err) {
        state.kbmapLoading = false;
        state.kbmapError = String(err && err.message || err);
        drawKbMap();
        renderKbSide();
      });
    }
    if (mode === 'tags' && !state.tagsData && !state.tagsLoading && !state.tagsError) {
      state.tagsLoading = true;
      fetch('/api/kb/tags').then(function (r) {
        if (!r.ok) throw new Error('知识缓存还没生成（服务会自动建；点「管理知识缓存」可手动加）');
        return r.json();
      }).then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.error) || '没有标签数据');
        state.tagsData = data;
        state.kbLogCount = Number(data.total) || 0;
        state.tagsLoading = false;
        paintKbCacheCount();
        rerenderKbFilters();
        drawKbMap();
        renderKbSide();
      }).catch(function (err) {
        state.tagsLoading = false;
        state.tagsError = String(err && err.message || err);
        drawKbMap();
        renderKbSide();
      });
    }
    if (mode === 'code' && !state.codeMap && !state.codeMapLoading && !state.codeMapError) {
      state.codeMapLoading = true;
      fetch('/api/kb/code-map').then(function (r) {
        if (!r.ok) throw new Error('代码地图还没生成（知识缓存为空；先去「管理知识缓存」加几条）');
        return r.json();
      }).then(function (data) {
        if (!data || data.ok === false) throw new Error((data && data.error) || '没有代码地图数据');
        state.codeMap = data;
        state.kbLogCount = Math.max(state.kbLogCount, Number(data.total) || 0);
        state.codeMapLoading = false;
        paintKbCacheCount();
        rerenderKbFilters();
        drawKbMap();
        renderKbSide();
      }).catch(function (err) {
        state.codeMapLoading = false;
        state.codeMapError = String(err && err.message || err);
        drawKbMap();
        renderKbSide();
      });
    }
  }

  function kbProjectCounts() {
    var counts = {};
    if (state.kbmapMode === 'tags') {
      tagNodes().forEach(function (n) { counts[n.p || '未标注'] = (counts[n.p || '未标注'] || 0) + 1; });
    } else if (state.kbmapMode === 'code') {
      ((state.codeMap && state.codeMap.files) || []).forEach(function (f) {
        counts[f.project || '未定位'] = (counts[f.project || '未定位'] || 0) + 1;
      });
    } else {
      ((state.kbmap && state.kbmap.nodes) || []).forEach(function (n) {
        counts[n.project || '未标注'] = (counts[n.project || '未标注'] || 0) + 1;
      });
    }
    return counts;
  }

  function renderKbFilters() {
    var counts = kbProjectCounts();
    var projects = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 8);
    var laneChips = state.kbmapMode === 'tags' ? null : el('div', { class: 'kb-chip-row' }, [
      el('span', { class: 'kb-chip-label', text: '线' }),
      kbChip('all', '全部', state.kbLane === 'all', function () { state.kbLane = 'all'; rerenderKbFilters(); }),
      ['mechanism', 'syntax', 'algorithm', 'judgment'].map(function (k) {
        return kbChip(k, KE_LANE[k].name, state.kbLane === k, function () { state.kbLane = k; rerenderKbFilters(); });
      })
    ]);
    var colorChips = state.kbmapMode === 'semantic' ? el('div', { class: 'kb-chip-row' }, [
      el('span', { class: 'kb-chip-label', text: '配色' }),
      kbChip('lane', '按线', state.kbColor === 'lane', function () { state.kbColor = 'lane'; rerenderKbFilters(); }),
      kbChip('project', '按项目', state.kbColor === 'project', function () { state.kbColor = 'project'; rerenderKbFilters(); })
    ]) : null;
    var projChips = el('div', { class: 'kb-chip-row' }, [
      el('span', { class: 'kb-chip-label', text: '项目' }),
      kbChip('all', '全部', state.kbProject === 'all', function () { state.kbProject = 'all'; rerenderKbFilters(); }),
      projects.map(function (p) {
        return kbChip(p, p.length > 14 ? p.slice(0, 13) + '…' : p, state.kbProject === p, function () { state.kbProject = p; rerenderKbFilters(); });
      })
    ]);
    var search = el('input', {
      class: 'kb-search', type: 'search', placeholder: '搜标题 / 一句话 / 文件…',
      value: state.kbQuery,
      on: {
        input: function (ev) { state.kbQuery = ev.target.value.trim(); drawKbMap(); }
      }
    });
    return el('div', { class: 'kb-filters' }, [laneChips, colorChips, projChips, search]);
  }

  function kbChip(id, name, on, handler) {
    return el('button', {
      class: 'kb-chip' + (on ? ' is-on' : ''),
      type: 'button',
      'data-id': id,
      'aria-pressed': on ? 'true' : 'false',
      on: { click: handler }
    }, name);
  }

  function rerenderKbFilters() {
    var host = $('.kb-filters');
    if (!host) return;
    var fresh = renderKbFilters();
    host.parentNode.replaceChild(fresh, host);
    drawKbMap();
  }

  /* ── 知识缓存管理（地图的数据源，不受 50 张卡上限） ──────────── */

  var kbLogState = { items: [], counts: null, vocab: [], lanes: [], q: '', status: 'all', editing: null, note: '' };

  var KB_STATUS_NAME = { active: '活跃', pending: '待展开', archived: '已归档' };
  var KB_ORIGIN_NAME = { card: '卡片', history: '历史补卡', seed: '种子卡', manual: '手动', ingest: '入库' };

  function renderKbCacheStrip() {
    var count = state.kbLogCount;
    return el('div', { class: 'kb-cache-strip' }, [
      el('span', { class: 'kb-cache-strip-text', text: '知识缓存' + (count ? ' · ' + count + ' 条' : ' · 空') }),
      el('button', { class: 'btn btn-quiet', type: 'button', on: { click: function () { openKbManager(); } } }, '管理知识缓存'),
      el('button', { class: 'btn btn-quiet', type: 'button', on: { click: refreshKbMaps } }, '刷新地图'),
      el('a', { class: 'kb-cache-strip-link', href: './settings.html#embedding', text: 'Embedding 设置' })
    ]);
  }

  function paintKbCacheCount() {
    var t = $('.kb-cache-strip-text');
    if (t) t.textContent = '知识缓存' + (state.kbLogCount ? ' · ' + state.kbLogCount + ' 条' : ' · 空');
  }

  /* ── 语义地图：embedding 接没接，如实说清楚 ───────────────── */

  function paintKbEmbedNote() {
    var host = document.getElementById('kb-embed-note');
    if (!host) return;
    host.textContent = '';
    if (state.kbmapMode !== 'semantic') { host.style.display = 'none'; return; }
    host.style.display = '';
    var em = state.kbmap && state.kbmap.embedding;
    if (!em) {
      host.className = 'kb-embed-note is-local';
      host.appendChild(el('span', { text: '语义地图数据还没生成；生成后会在这里说明用的是哪种相似度。' }));
      return;
    }
    if (em.mode === 'remote-embedding') {
      host.className = 'kb-embed-note is-on';
      host.appendChild(el('span', {
        text: '语义地图：远程 embedding · ' + (em.model || '?') + ' · ' + (em.dim || '?') + ' 维 · ' +
          (em.provider || 'openai-compatible') + (em.apiCalls ? '（本轮请求 ' + em.apiCalls + ' 批）' : '（缓存命中）')
      }));
    } else {
      host.className = 'kb-embed-note is-local';
      var why = em.reason && !/默认关闭/.test(em.reason) ? '（' + em.reason + '）' : '';
      host.appendChild(el('span', { text: '未接 embedding：当前按本地字面相似度（bigram TF-IDF）排布，挨得近 ≠ 语义相近。' + why }));
    }
    host.appendChild(el('a', { href: './settings.html#embedding', text: em.mode === 'remote-embedding' ? '设置' : '去设置接一个 OpenAI 兼容接口 →' }));
  }

  /* ── 快捷跳转：知识条目 → 卡片 / 会话 ─────────────────────── */

  function jumpToCard(cardId) {
    if (!cardId) return;
    var overlay = $('.kb-manager-modal');
    if (overlay) overlay.remove();
    go('#deck/' + encodeURIComponent(cardId));
  }

  function jumpToSession(source) {
    var session = (source && source.session) || '';
    if (!session) return;
    openLocate({ session: session, quote: '' });
  }

  function kbJumpButtons(cardId, source, extraClass) {
    var btns = [];
    if (cardId) {
      btns.push(el('button', {
        class: 'btn btn-quiet ' + (extraClass || ''), type: 'button',
        on: { click: function () { jumpToCard(cardId); } }
      }, '看卡片'));
    }
    if (source && source.session) {
      btns.push(el('button', {
        class: 'btn btn-quiet ' + (extraClass || ''), type: 'button',
        on: { click: function () { jumpToSession(source); } }
      }, '回到现场'));
    }
    return btns;
  }

  function refreshKbMaps() {
    state.tagsData = null; state.tagsError = null; state.tagsLoading = false;
    state.codeMap = null; state.codeMapError = null; state.codeMapLoading = false;
    state.kbmap = null; state.kbmapError = null; state.kbmapLoading = false;
    kbView.tagsReady = false;
    if (state.route.view === 'kbmap') {
      ensureKbData(state.kbmapMode);
      render();
    } else {
      ensureKbData(state.kbmapMode);
      drawKbMap();
      renderKbSide();
    }
  }

  function openKbManager(keep) {
    if (!keep) kbLogState = { items: [], counts: null, vocab: [], lanes: [], q: '', status: 'all', editing: null, note: '' };
    var old = $('.kb-manager-modal');
    if (old) old.remove();
    var note = el('p', { class: 'kb-modal-note', id: 'kb-cache-note', text: '正在读知识缓存…' });
    var list = el('div', { class: 'kb-cache-list', id: 'kb-cache-list' });
    var search = el('input', {
      class: 'kb-cache-search', type: 'search', value: kbLogState.q,
      placeholder: '搜标题 / 一句话 / 标签 / 项目…',
      on: {
        input: function (ev) {
          clearTimeout(search._t);
          var v = ev.target.value.trim();
          search._t = setTimeout(function () { kbLogState.q = v; fetchKbLog(); }, 260);
        }
      }
    });
    var statusSel = el('select', {
      class: 'kb-cache-select',
      on: { change: function (ev) { kbLogState.status = ev.target.value; fetchKbLog(); } }
    }, [
      el('option', { value: 'all', text: '全部状态' }),
      el('option', { value: 'active', text: '活跃' }),
      el('option', { value: 'pending', text: '待展开' }),
      el('option', { value: 'archived', text: '已归档' })
    ]);
    statusSel.value = kbLogState.status;
    var addBtn = el('button', {
      class: 'btn btn-quiet', type: 'button',
      on: { click: function () { kbLogState.editing = '__new__'; renderKbCacheList(); } }
    }, '＋ 加一条');
    var toolbar = el('div', { class: 'kb-cache-toolbar' }, [search, statusSel, addBtn]);
    var closeBtn = el('button', { class: 'btn btn-quiet', type: 'button', on: { click: function () { overlay.remove(); } } }, '关闭');
    var overlay = el('div', { class: 'kb-modal kb-manager-modal', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'kb-modal-in kb-manager-in' }, [
        el('div', { class: 'kb-modal-head' }, [el('b', { text: '知识缓存' }), closeBtn]),
        el('p', { class: 'kb-modal-note', text: '知识地图的数据源。不受 50 张卡上限限制；卡片、历史补卡、种子卡会自动同步进来，也可以手动增删改。标签请从受控词表里选（用逗号分隔）。' }),
        note, toolbar, list
      ])
    ]);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    fetchKbLog();
  }

  function fetchKbLog() {
    var params = '?limit=500&status=' + encodeURIComponent(kbLogState.status) + '&q=' + encodeURIComponent(kbLogState.q);
    fetch('/api/kb/log' + params).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '读不到知识缓存');
      kbLogState.items = d.items || [];
      kbLogState.counts = d.counts || null;
      kbLogState.vocab = d.vocab || [];
      kbLogState.lanes = d.lanes || [];
      var c = d.counts || {};
      var note = $('#kb-cache-note');
      if (note) note.textContent = '共 ' + (c.all || 0) + ' 条 · 活跃 ' + (c.active || 0) + ' · 待展开 ' + (c.pending || 0) + ' · 已归档 ' + (c.archived || 0);
      renderKbCacheList();
    }).catch(function (err) {
      var note = $('#kb-cache-note');
      if (note) { note.textContent = '读不到知识缓存：' + String(err && err.message || err); note.className = 'kb-modal-note is-bad'; }
    });
  }

  function renderKbCacheList() {
    var list = $('#kb-cache-list');
    if (!list) return;
    list.textContent = '';
    if (kbLogState.editing === '__new__') {
      list.appendChild(kbLogEditRow(null));
      return;
    }
    if (!kbLogState.items.length) {
      list.appendChild(el('p', { class: 'kb-cache-empty', text: '还没有知识条目。点「加一条」手动加，或先去卡片流生成几张卡——服务会自动同步。' }));
      return;
    }
    kbLogState.items.forEach(function (it) {
      list.appendChild(kbLogState.editing === it.id ? kbLogEditRow(it) : kbLogRow(it));
    });
  }

  function laneName(key) {
    return KE_LANE[key] ? KE_LANE[key].name : key;
  }

  function kbLogRow(it) {
    var meta = [
      it.project || '未标注', laneName(it.lane),
      it.tags.length ? it.tags.join(' · ') : '无标签',
      KB_ORIGIN_NAME[it.origin] || it.origin
    ].join(' ｜ ');
    return el('div', { class: 'kb-cache-row' }, [
      el('div', { class: 'kb-cache-row-head' }, [
        el('b', { text: it.title }),
        el('span', { class: 'kb-cache-badge' + (it.status !== 'active' ? ' is-' + it.status : ''), text: KB_STATUS_NAME[it.status] || it.status })
      ]),
      it.summary ? el('p', { class: 'kb-cache-summary', text: it.summary }) : null,
      el('p', { class: 'kb-cache-meta', text: meta }),
      el('div', { class: 'kb-cache-actions' }, [].concat(kbJumpButtons(it.cardId, it.source), [
        el('button', { class: 'btn btn-quiet', type: 'button', on: { click: function () { kbLogState.editing = it.id; renderKbCacheList(); } } }, '编辑'),
        el('button', {
          class: 'btn btn-quiet', type: 'button',
          on: { click: function () { setKbLogStatus(it, it.status === 'archived' ? 'active' : 'archived'); } }
        }, it.status === 'archived' ? '恢复' : '归档'),
        el('button', { class: 'btn btn-quiet is-danger', type: 'button', on: { click: function () { removeKbLog(it); } } }, '删除')
      ]))
    ]);
  }

  function kbLogEditRow(it) {
    var isNew = !it;
    var v = it || { title: '', summary: '', text: '', tags: [], project: '', lane: 'mechanism', status: 'active' };
    var title = el('input', { class: 'kb-cache-input', value: v.title, placeholder: '标题（一句话说清是什么）' });
    var summary = el('input', { class: 'kb-cache-input', value: v.summary, placeholder: '一句话结论（可选）' });
    var tags = el('input', {
      class: 'kb-cache-input', value: (v.tags || []).join('，'),
      list: 'kb-vocab-options', placeholder: '标签，用逗号分隔（如：路径，进程）'
    });
    var project = el('input', { class: 'kb-cache-input', value: v.project === '未标注' ? '' : v.project, placeholder: '项目（可选）' });
    var lane = el('select', { class: 'kb-cache-select' }, (kbLogState.lanes.length ? kbLogState.lanes : ['mechanism', 'syntax', 'algorithm', 'judgment']).map(function (k) {
      return el('option', { value: k, text: laneName(k) });
    }));
    lane.value = v.lane || 'mechanism';
    var status = el('select', { class: 'kb-cache-select' }, [
      el('option', { value: 'active', text: '活跃' }),
      el('option', { value: 'pending', text: '待展开' }),
      el('option', { value: 'archived', text: '已归档' })
    ]);
    status.value = v.status || 'active';
    var datalist = el('datalist', { id: 'kb-vocab-options' }, (kbLogState.vocab || []).map(function (t) {
      return el('option', { value: t });
    }));
    var err = el('p', { class: 'kb-modal-note is-bad', style: 'display:none' });
    function fail(msg) { err.textContent = msg; err.style.display = 'block'; }
    function save() {
      var payload = {
        title: title.value.trim(), summary: summary.value.trim(),
        tags: tags.value.split(/[，,、]/).map(function (s) { return s.trim(); }).filter(Boolean),
        project: project.value.trim(), lane: lane.value, status: status.value
      };
      if (!payload.title) return fail('标题不能为空');
      var url = isNew ? '/api/kb/log/add' : '/api/kb/log/update';
      if (!isNew) payload.id = it.id;
      fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.error) || '保存失败');
        kbLogState.editing = null;
        fetchKbLog();
        refreshKbMaps();
      }).catch(function (e) { fail(String(e && e.message || e)); });
    }
    return el('div', { class: 'kb-cache-row is-editing' }, [
      datalist,
      el('div', { class: 'kb-cache-form' }, [title, summary, tags, project]),
      el('div', { class: 'kb-cache-form kb-cache-form-row' }, [lane, status]),
      err,
      el('div', { class: 'kb-cache-actions' }, [
        el('button', { class: 'btn btn-primary', type: 'button', on: { click: save } }, '保存'),
        el('button', {
          class: 'btn btn-quiet', type: 'button',
          on: { click: function () { kbLogState.editing = null; renderKbCacheList(); } }
        }, '取消')
      ])
    ]);
  }

  function setKbLogStatus(it, status) {
    fetch('/api/kb/log/update', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: it.id, status: status })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '状态没改成');
      fetchKbLog();
      refreshKbMaps();
    }).catch(function (e) { window.alert(String(e && e.message || e)); });
  }

  function removeKbLog(it) {
    if (!window.confirm('删除「' + it.title + '」这条知识缓存？删除后知识地图会少这个点。')) return;
    fetch('/api/kb/log/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: it.id })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '删除失败');
      fetchKbLog();
      refreshKbMaps();
    }).catch(function (e) { window.alert(String(e && e.message || e)); });
  }

  function kbItemMatches(item) {
    if (!item) return false;
    if (state.kbProject !== 'all') {
      var p = item.project || item.p || '';
      if (p !== state.kbProject) return false;
    }
    if (state.kbmapMode !== 'tags' && state.kbLane !== 'all') {
      if (item.lane !== state.kbLane) return false;
    }
    if (state.kbQuery) {
      var q = state.kbQuery.toLowerCase();
      var hay = [item.title, item.summary, item.id, item.path, item.project, item.p].filter(Boolean).join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function kbNodePos(n, W, H) {
    var pad = 46;
    return {
      x: pad + (Number(n.x) || 0) * (W - pad * 2),
      y: pad + (Number(n.y) || 0) * (H - pad * 2)
    };
  }

  function kbCanvas() {
    var cv = kbView.canvas || document.getElementById('kb-canvas');
    if (cv) kbView.canvas = cv;
    return cv;
  }

  function drawKbMap() {
    var cv = kbCanvas();
    if (!cv) return;
    // 代码地图要放两行标签（文件名 + 项目），给它多一点高度
    var wantH = state.kbmapMode === 'code' ? 760 : 640;
    if (cv.height !== wantH) cv.height = wantH;
    var ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    kbView.semantic = [];
    kbView.code = [];
    kbView.tag = [];
    kbView.files = [];
    if (state.kbmapMode === 'semantic') drawSemanticMap(ctx, cv);
    else if (state.kbmapMode === 'tags') drawTagMap(ctx, cv);
    else drawCodeMap(ctx, cv);
  }

  function drawKbNotice(ctx, cv, text) {
    ctx.fillStyle = C.ink3;
    ctx.font = '13px "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, cv.width / 2, cv.height / 2);
  }

  function drawSemanticMap(ctx, cv) {
    if (!state.kbmap) {
      drawKbNotice(ctx, cv, state.kbmapLoading ? '正在算语义地图…' : (state.kbmapError || '没有语义地图数据'));
      return;
    }
    var nodes = state.kbmap.nodes || [];
    var W = cv.width, H = cv.height;
    var hoverId = kbView.hover && kbView.hover.kind === 'entry' ? kbView.hover.id : null;
    var pick = state.kbPickType === 'semantic' ? state.kbPick : null;

    nodes.forEach(function (n) {
      var pos = kbNodePos(n, W, H);
      var match = kbItemMatches(n);
      var color = state.kbColor === 'project' ? kbProjectColor(n.project || '未标注') : (KE_LANE[n.lane] || { color: C.ink3 }).color;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 5, 0, 7);
      ctx.fillStyle = color;
      ctx.globalAlpha = match ? 0.85 : 0.12;
      ctx.fill();
      kbView.semantic.push({ id: n.id, x: pos.x, y: pos.y, title: n.title });
      if (n.id === pick || n.id === hoverId) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 9, 0, 7);
        ctx.strokeStyle = match ? C.ink : C.line2;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;

    var label = null;
    if (hoverId) label = nodes.find(function (n) { return n.id === hoverId; });
    else if (pick) label = nodes.find(function (n) { return n.id === pick; });
    if (label) {
      var p = kbNodePos(label, W, H);
      var text = label.title || label.id;
      ctx.font = '12.5px "PingFang SC", sans-serif';
      var tw = ctx.measureText(text).width;
      var tx = Math.max(8, Math.min(W - tw - 8, p.x - tw / 2));
      var ty = p.y + 22;
      ctx.fillStyle = C.card;
      ctx.fillRect(tx - 4, ty - 13, tw + 8, 18);
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'left';
      ctx.fillText(text, tx, ty);
    }
  }

  function drawTagMap(ctx, cv) {
    if (!state.tagsData || !tagNodes().length) {
      var msg = state.tagsLoading ? '正在算标签网络…' : (state.tagsError || '知识缓存还是空的：先在「管理知识缓存」里加几条');
      drawKbNotice(ctx, cv, msg);
      return;
    }
    layoutTagNodes();
    var W = cv.width, H = cv.height;
    var nodes = tagNodes(), links = tagLinks();
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    var focus = state.kbPickType === 'tags' ? state.kbPick : null;

    links.forEach(function (l) {
      var a = byId[l.s], b = byId[l.t];
      if (!a || !b) return;
      var am = kbItemMatches({ id: a.id, p: a.p });
      var bm = kbItemMatches({ id: b.id, p: b.p });
      var on = focus && (l.s === focus || l.t === focus);
      ctx.strokeStyle = on ? C.linkOn : (am && bm ? C.link : C.linkDim);
      ctx.lineWidth = on ? 1.6 : 0.8;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });

    nodes.forEach(function (n) {
      var r = 4 + n.n * 1.7;
      var match = kbItemMatches(n);
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7);
      ctx.fillStyle = n.c;
      ctx.globalAlpha = match ? (focus && focus !== n.id ? 0.3 : 0.9) : 0.1;
      ctx.fill();
      kbView.tag.push({ id: n.id, x: n.x, y: n.y, r: r, tip: n.id + ' · ' + n.n + ' 条 · ' + n.p });
    });
    ctx.globalAlpha = 1;

    // 标签贴着自己的点：默认正下方，遮挡先缩字号、再微调
    var placed = [];
    function hitDot(b, n) {
      var cx = Math.max(b.x1, Math.min(n.x, b.x2)), cy = Math.max(b.y1, Math.min(n.y, b.y2));
      return Math.hypot(n.x - cx, n.y - cy) < (4 + n.n * 1.7) + 2;
    }
    function hitBox(a, b) { return !(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1); }
    nodes.slice().sort(function (a, b) { return b.n - a.n; }).forEach(function (n) {
      var r = 4 + n.n * 1.7, best = null, bestScore = 1e9;
      for (var si = 0; si < 6; si++) {
        var size = [11, 10.5, 10, 9.5, 9, 8.5][si];
        ctx.font = size + 'px "PingFang SC", sans-serif';
        var w = ctx.measureText(n.id).width;
        var dys = [r + 12, r + 10, r + 14, r + 9, r + 16];
        for (var di = 0; di < dys.length; di++) {
          var dy = dys[di];
          var b = { x1: n.x - w / 2, x2: n.x + w / 2, y1: n.y + dy - size, y2: n.y + dy + 3 };
          var score = 0;
          nodes.forEach(function (o) { if (o !== n && hitDot(b, o)) score += 1; });
          placed.forEach(function (L) { if (hitBox(b, L.b)) score += 1; });
          if (b.x1 < 2 || b.x2 > W - 2 || b.y2 > H - 2) score += 2;
          if (score < bestScore) { bestScore = score; best = { b: b, size: size }; }
          if (score === 0) break;
        }
        if (best && bestScore === 0) break;
      }
      if (best) {
        placed.push(best);
        ctx.font = best.size + 'px "PingFang SC", sans-serif';
        var cx = (best.b.x1 + best.b.x2) / 2, cy = best.b.y2 - 3;
        var match = kbItemMatches(n);
        ctx.lineWidth = 3.5; ctx.strokeStyle = C.mapHalo;
        ctx.strokeText(n.id, cx, cy);
        ctx.fillStyle = !match ? C.ink3 : (focus && focus !== n.id ? C.ink3 : C.ink);
        ctx.textAlign = 'center';
        ctx.fillText(n.id, cx, cy);
      }
    });
  }

  function baseName(p) {
    var parts = String(p || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p || '');
  }

  function drawCodeMap(ctx, cv) {
    if (!state.codeMap || (!(state.codeMap.files || []).length && !(state.codeMap.unlocated || []).length)) {
      var msg = state.codeMapLoading ? '正在按文件聚类…'
        : (state.codeMapError || '知识缓存还是空的：先在「管理知识缓存」里加几条');
      drawKbNotice(ctx, cv, msg);
      return;
    }
    var W = cv.width, H = cv.height;
    var clusters = (state.codeMap.files || []).slice();
    var un = state.codeMap.unlocated || [];
    if (un.length) clusters.push({ path: '（未定位到文件）', project: '', n: un.length, entries: un });
    clusters.sort(function (a, b) {
      var pa = a.project || '未定位', pb = b.project || '未定位';
      if (pa !== pb) return pa.localeCompare(pb);
      return (b.entries || []).length - (a.entries || []).length;
    });

    var cols = Math.max(4, Math.min(8, Math.ceil(Math.sqrt(clusters.length * 1.25))));
    var rows = Math.ceil(clusters.length / cols);
    var cellW = W / cols, cellH = H / rows;
    var maxR = Math.min(cellW, cellH) * 0.32;

    clusters.forEach(function (f, ci) {
      var col = ci % cols, row = Math.floor(ci / cols);
      var cx = (col + 0.5) * cellW;
      var cy = (row + 0.5) * cellH - 6;
      var entries = f.entries || [];
      var n = entries.length;
      var r = Math.min(maxR, 12 + Math.sqrt(n) * 6.5);
      var projColor = kbProjectColor(f.project || '未定位');
      var anyMatch = entries.some(function (e) { return kbItemMatches(e); }) ||
        kbItemMatches({ path: f.path, project: f.project });
      var dim = !anyMatch;

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 7);
      ctx.fillStyle = projColor;
      ctx.globalAlpha = dim ? 0.05 : 0.1;
      ctx.fill();
      ctx.globalAlpha = dim ? 0.18 : 0.45;
      ctx.strokeStyle = projColor;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      var placed = [];
      entries.forEach(function (e, i) {
        var ang = i * 2.399963;
        var rad = n === 1 ? 0 : Math.min(r - 4, 5 + Math.sqrt(i) * (r * 0.62 / Math.sqrt(n)));
        var x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad;
        placed.push({ x: x, y: y });
        var lane = KE_LANE[e.lane] || { color: C.ink3 };
        var m = kbItemMatches(e);
        ctx.beginPath();
        ctx.arc(x, y, 3.3, 0, 7);
        ctx.fillStyle = lane.color;
        ctx.globalAlpha = m ? 0.9 : 0.12;
        ctx.fill();
        ctx.globalAlpha = 1;
        kbView.code.push({ kind: 'entry', id: e.id, x: x, y: y, r: 5, title: e.title });
      });

      var fullName = baseName(f.path);
      var proj = f.project || '未定位';
      ctx.font = '10.5px "PingFang SC", sans-serif';
      var maxW = Math.max(40, cellW - 10);
      var short = fullName;
      if (ctx.measureText(short).width > maxW) {
        while (short.length > 3 && ctx.measureText(short + '…').width > maxW) short = short.slice(0, -1);
        short += '…';
      }
      ctx.fillStyle = dim ? C.ink3 : C.ink2;
      ctx.textAlign = 'center';
      ctx.fillText(short, cx, cy + r + 13);
      ctx.font = '9.5px "PingFang SC", sans-serif';
      var projShow = proj;
      while (projShow.length > 3 && ctx.measureText(projShow + '…').width > maxW) projShow = projShow.slice(0, -1);
      if (projShow !== proj) projShow += '…';
      ctx.fillStyle = C.ink3;
      ctx.fillText(projShow, cx, cy + r + 26);
      kbView.files.push({ path: f.path, x: cx, y: cy + r + 18, w: ctx.measureText(short).width });
    });
  }

  function kbProjectColor(project) {
    var list = Object.keys(kbProjectCounts()).sort(function (a, b) { return kbProjectCounts()[b] - kbProjectCounts()[a]; });
    var i = Math.max(0, list.indexOf(project));
    return KB_PROJECT_COLORS[i % KB_PROJECT_COLORS.length];
  }

  function layoutTagNodes() {
    var nodes = tagNodes();
    if (!nodes.length) return;
    if (kbView.tagsReady) return;
    var W = 900, H = 640;
    nodes.forEach(function (n, i) {
      n.x = W / 2 + Math.sin(i * 2.1) * W * 0.28 + Math.cos(i * 1.3) * W * 0.16;
      n.y = H / 2 + Math.cos(i * 1.7) * H * 0.28 + Math.sin(i * 0.9) * H * 0.12;
    });
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    var links = tagLinks().map(function (l) { return { a: byId[l.s], b: byId[l.t], w: l.w }; })
      .filter(function (l) { return l.a && l.b; });
    for (var it = 0; it < 260; it++) {
      for (var i = 0; i < nodes.length; i++) {
        for (var j = i + 1; j < nodes.length; j++) {
          var a = nodes[i], b = nodes[j];
          var dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
          var f = 5200 / (d * d);
          dx /= d; dy /= d; a.x -= dx * f; b.x += dx * f; a.y -= dy * f; b.y += dy * f;
        }
      }
      links.forEach(function (l) {
        var dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.hypot(dx, dy) || 1;
        var k = (d - 150) * 0.02 * l.w; dx /= d; dy /= d;
        l.a.x += dx * k; l.a.y += dy * k; l.b.x -= dx * k; l.b.y -= dy * k;
      });
      nodes.forEach(function (n) {
        n.x += (W / 2 - n.x) * 0.004; n.y += (H / 2 - n.y) * 0.004;
        n.x = Math.max(60, Math.min(W - 60, n.x)); n.y = Math.max(40, Math.min(H - 40, n.y));
      });
    }
    kbView.tagsReady = true;
  }

  function tagNodes() { return (state.tagsData && state.tagsData.nodes) || []; }
  function tagLinks() { return (state.tagsData && state.tagsData.links) || []; }

  function findKbNode(id) {
    if (state.kbmapMode === 'semantic') {
      return ((state.kbmap && state.kbmap.nodes) || []).find(function (n) { return n.id === id; }) || null;
    }
    if (state.kbmapMode === 'code') {
      var files = (state.codeMap && state.codeMap.files) || [];
      for (var i = 0; i < files.length; i++) {
        var e = (files[i].entries || []).find(function (x) { return x.id === id; });
        if (e) return Object.assign({}, e, { path: files[i].path, project: files[i].project });
      }
      var un = (state.codeMap && state.codeMap.unlocated) || [];
      var u = un.find(function (x) { return x.id === id; });
      return u || null;
    }
    return null;
  }

  function bindKbCanvas() {
    var cv = document.getElementById('kb-canvas');
    if (!cv) return;
    kbView.canvas = cv;
    function point(ev) {
      var r = cv.getBoundingClientRect();
      return { x: (ev.clientX - r.left) * cv.width / r.width, y: (ev.clientY - r.top) * cv.height / r.height };
    }
    function hitTest(p) {
      if (state.kbmapMode === 'tags') {
        var best = null, bd = 1e9;
        kbView.tag.forEach(function (n) {
          var d = Math.hypot(n.x - p.x, n.y - p.y);
          if (d < n.r + 6 && d < bd) { bd = d; best = n; }
        });
        return best ? { kind: 'tag', id: best.id, tip: best.tip, x: best.x, y: best.y } : null;
      }
      if (state.kbmapMode === 'code') {
        var bestE = null, bdE = 1e9;
        kbView.code.forEach(function (n) {
          var d = Math.hypot(n.x - p.x, n.y - p.y);
          if (d < 7 && d < bdE) { bdE = d; bestE = n; }
        });
        if (bestE) return { kind: 'entry', id: bestE.id, tip: bestE.title, x: bestE.x, y: bestE.y };
        var bestF = null;
        kbView.files.forEach(function (f) {
          if (Math.abs(p.y - f.y) < 10 && Math.abs(p.x - f.x) < f.w / 2 + 6) bestF = f;
        });
        return bestF ? { kind: 'file', path: bestF.path, tip: bestF.path, x: bestF.x, y: bestF.y } : null;
      }
      var best = null, bd = 1e9;
      kbView.semantic.forEach(function (n) {
        var d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < 10 && d < bd) { bd = d; best = n; }
      });
      return best ? { kind: 'entry', id: best.id, tip: best.title, x: best.x, y: best.y } : null;
    }
    cv.addEventListener('mousemove', function (ev) {
      var p = point(ev);
      var hit = hitTest(p);
      var tip = document.getElementById('kb-tip');
      if (hit !== null || kbView.hover) {
        kbView.hover = hit;
        if (tip) {
          if (hit) {
            tip.textContent = hit.tip || '';
            tip.style.opacity = 1;
            tip.style.left = (ev.clientX - cv.getBoundingClientRect().left + 14) + 'px';
            tip.style.top = (ev.clientY - cv.getBoundingClientRect().top + 14) + 'px';
          } else tip.style.opacity = 0;
        }
        drawKbMap();
      }
    });
    cv.addEventListener('mouseleave', function () {
      kbView.hover = null;
      var tip = document.getElementById('kb-tip');
      if (tip) tip.style.opacity = 0;
      drawKbMap();
    });
    cv.addEventListener('click', function (ev) {
      var hit = hitTest(point(ev));
      if (!hit) return;
      if (hit.kind === 'file') {
        state.kbPick = hit.path;
        state.kbPickType = 'file';
        renderKbSide();
        return;
      }
      state.kbPick = hit.id;
      state.kbPickType = state.kbmapMode === 'code' ? 'code' : 'semantic';
      if (state.kbmapMode === 'tags') state.kbPickType = 'tags';
      renderKbSide();
      drawKbMap();
    });
  }

  function renderKbSide() {
    var side = document.getElementById('kb-side');
    if (!side) return;
    side.textContent = '';
    if (state.kbmapMode === 'tags') return renderTagSide(side);
    if (state.kbPickType === 'file' && state.kbPick) return renderFileSide(side, state.kbPick);
    if (state.kbPick && (state.kbPickType === 'semantic' || state.kbPickType === 'code')) {
      return renderEntrySide(side, state.kbPick);
    }
    if (state.kbmapMode === 'semantic') {
      side.appendChild(el('h2', { class: 'tags-side-title', text: '点一个点' }));
      side.appendChild(el('p', { class: 'tags-side-note', text: '每个点是一条知识，挨得近的语义相近。右边会出标题、来源、最近邻。' }));
      var laneCounts = {};
      ((state.kbmap && state.kbmap.nodes) || []).forEach(function (n) { laneCounts[n.lane] = (laneCounts[n.lane] || 0) + 1; });
      Object.keys(KE_LANE).forEach(function (k) {
        if (!laneCounts[k]) return;
        side.appendChild(el('div', { class: 'kb-stat' }, [
          el('i', { style: 'background:' + KE_LANE[k].color }),
          el('span', { text: KE_LANE[k].name }),
          el('b', { text: laneCounts[k] + ' 条' })
        ]));
      });
      return;
    }
    side.appendChild(el('h2', { class: 'tags-side-title', text: '按文件找' }));
    side.appendChild(el('p', { class: 'tags-side-note', text: '点一个点看知识；点文件名字看这个文件关联的全部条目。' }));
    var files = ((state.codeMap && state.codeMap.files) || []).slice(0, 8);
    files.forEach(function (f) {
      side.appendChild(el('button', {
        class: 'kb-file-row', type: 'button',
        on: { click: function () { state.kbPick = f.path; state.kbPickType = 'file'; renderKbSide(); } }
      }, [
        el('b', { text: baseName(f.path) }),
        el('span', { text: (f.entries || []).length + ' 条 · ' + (f.project || '未定位') })
      ]));
    });
  }

  function renderFileSide(side, path) {
    var files = (state.codeMap && state.codeMap.files) || [];
    var f = files.find(function (x) { return x.path === path; });
    if (!f) return renderKbSide(side);
    side.appendChild(el('div', { class: 'tags-side-head' }, [
      el('h2', { class: 'tags-side-title', text: baseName(f.path) }),
      el('button', { class: 'btn btn-quiet', type: 'button', on: { click: function () { state.kbPick = null; renderKbSide(); } } }, '返回')
    ]));
    side.appendChild(el('p', { class: 'tags-side-src', text: f.path }));
    (f.entries || []).forEach(function (e) {
      side.appendChild(el('button', {
        class: 'tags-entry', type: 'button',
        on: { click: function () { state.kbPick = e.id; state.kbPickType = 'code'; renderKbSide(); } }
      }, el('b', { text: e.title })));
    });
  }

  function renderEntrySide(side, id) {
    var node = findKbNode(id);
    if (!node) return renderKbSide(side);
    var back = el('button', {
      class: 'btn btn-quiet', type: 'button',
      on: { click: function () { state.kbPick = null; renderKbSide(); } }
    }, '返回');
    side.appendChild(el('div', { class: 'tags-side-head' }, [
      el('h2', { class: 'tags-side-title', text: node.title || id }),
      back
    ]));
    if (node.summary) side.appendChild(el('p', { class: 'tags-side-note', text: node.summary }));
    var meta = [];
    if (node.lane && KE_LANE[node.lane]) meta.push(KE_LANE[node.lane].name);
    if (node.project) meta.push(node.project);
    if (node.path) meta.push(node.path);
    if (meta.length) side.appendChild(el('p', { class: 'tags-side-src', text: meta.join(' · ') }));

    var actions = [];
    if (node.cardId) actions.push(el('button', {
      class: 'btn btn-quiet', type: 'button',
      on: { click: function () { jumpToCard(node.cardId); } }
    }, '看卡片'));
    actions.push(el('button', {
      class: 'btn btn-quiet', type: 'button',
      on: { click: function () { loadKbText(side, node, id); } }
    }, '看全文'));
    actions.push(el('button', {
      class: 'btn btn-quiet', type: 'button',
      on: { click: function () { locateFromEntry(id); } }
    }, '回到现场'));
    side.appendChild(el('div', { class: 'kb-detail-actions' }, actions));

    var body = el('div', { class: 'kb-detail-body', id: 'kb-detail-body' });
    side.appendChild(body);

    if (state.kbmapMode === 'semantic' && node.v) {
      var near = nearestKbNodes(node, 5);
      if (near.length) {
        side.appendChild(el('h3', { class: 'kb-sub', text: '最近邻' }));
        near.forEach(function (x) {
          side.appendChild(el('button', {
            class: 'kb-near', type: 'button',
            on: {
              click: function () {
                state.kbPick = x.node.id; state.kbPickType = 'semantic';
                renderKbSide(); drawKbMap();
              }
            }
          }, [
            el('b', { text: x.node.title }),
            el('span', { text: '相似 ' + x.sim.toFixed(2) })
          ]));
        });
      }
    }
  }

  function nearestKbNodes(node, k) {
    var nodes = (state.kbmap && state.kbmap.nodes) || [];
    var v = node.v || [];
    if (!v.length) return [];
    var out = [];
    nodes.forEach(function (n) {
      if (!n.v || n.id === node.id) return;
      var dot = 0;
      for (var i = 0; i < v.length; i++) dot += v[i] * (n.v[i] || 0);
      out.push({ node: n, sim: dot });
    });
    out.sort(function (a, b) { return b.sim - a.sim; });
    return out.slice(0, k);
  }

  function loadKbText(side, node, id) {
    var body = document.getElementById('kb-detail-body');
    if (!body) return;
    body.textContent = '正在取全文…';
    fetch('/api/kb/item?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (item) {
      body.textContent = '';
      var doc = item.document || '';
      var lines = doc.split('\n');
      var sum = lines[1] || '';
      var text = lines.slice(2).join('\n').trim() || doc;
      if (sum) body.appendChild(el('p', { class: 'tags-side-note', text: sum }));
      body.appendChild(el('p', { class: 'tags-side-body', text: text }));
      if (item.meta && item.meta.source) body.appendChild(el('p', { class: 'tags-side-src', text: item.meta.source }));
    }).catch(function () {
      body.textContent = '取不到全文，知识库服务可能没起。';
    });
  }

  function locateFromEntry(id) {
    var node = findKbNode(id) || {};
    var srcStr = node.source || '';
    var sm = /session=([\w.-]+)/.exec(srcStr);
    var ss = /#seq=([\d,]+)/.exec(srcStr);
    var fallback = { session: sm ? sm[1] : '', seq: ss ? ss[1] : '', quote: '' };
    fetch('/api/kb/item?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (item) {
      var meta = item.meta || {};
      var quotes = item.quotes || [];
      var q = quotes[0] || {};
      var src = meta.source || q.source || '';
      var m = /session=([\w.-]+)/.exec(src) || sm;
      var seq = /#seq=([\d,]+)/.exec(src) || ss;
      var qtext = q.text || '';
      if (!qtext && item.document) {
        var mm = /引文：(.+)/.exec(item.document);
        if (mm) qtext = mm[1].trim();
      }
      openLocate({ session: m ? m[1] : (meta.session || ''), seq: seq ? seq[1] : '', quote: qtext });
    }).catch(function () {
      openLocate(fallback);
    });
  }

  function renderTagSide(side) {
    var focus = state.kbPickType === 'tags' ? state.kbPick : null;
    if (!focus) {
      if (!tagNodes().length) {
        side.appendChild(el('h2', { class: 'tags-side-title', text: state.tagsError ? '标签网络没出来' : '知识缓存还是空的' }));
        side.appendChild(el('p', {
          class: 'tags-side-note',
          text: state.tagsError || '地图读的是本地知识缓存，不依赖本地模型。服务会从卡片/历史卡/种子卡自动同步；也可以手动加一条。'
        }));
        side.appendChild(el('button', {
          class: 'btn btn-quiet', type: 'button',
          on: { click: function () { openKbManager(); } }
        }, '管理知识缓存'));
        return;
      }
      side.appendChild(el('h2', { class: 'tags-side-title', text: '点一个标签' }));
      side.appendChild(el('p', { class: 'tags-side-note', text: '右侧会列出用了这个标签的条目。点连线上的点也行。' }));
      var top = tagNodes().slice().sort(function (a, b) { return b.n - a.n; }).slice(0, 8);
      top.forEach(function (n) {
        side.appendChild(el('button', {
          class: 'tag-chip', type: 'button',
          on: {
            click: function () {
              state.kbPick = n.id; state.kbPickType = 'tags'; state.tagsFocus = n.id;
              drawKbMap(); renderKbSide();
            }
          }
        }, [el('b', { text: n.id }), el('span', { text: n.n + ' 条' })]));
      });
      return;
    }
    var node = tagNodes().find(function (n) { return n.id === focus; });
    var list = (state.tagsData && state.tagsData.byTag && state.tagsData.byTag[focus]) || [];
    side.appendChild(el('div', { class: 'tags-side-head' }, [
      el('h2', { class: 'tags-side-title', text: focus }),
      el('button', {
        class: 'btn btn-quiet', type: 'button',
        on: { click: function () { state.kbPick = null; state.tagsFocus = null; drawKbMap(); renderKbSide(); } }
      }, '看全部')
    ]));
    side.appendChild(el('p', { class: 'tags-side-note', text: list.length + ' 条 · 主要项目 ' + (node ? node.p : '') }));
    list.forEach(function (it) {
      side.appendChild(el('button', {
        class: 'tags-entry', type: 'button',
        on: { click: function () { openTagItem(it.id, it.title); } }
      }, [el('b', { text: it.title })]));
    });
  }

  function openTagItem(id, title) {
    var side = document.getElementById('kb-side');
    if (!side) return;
    side.textContent = '';
    side.appendChild(el('div', { class: 'tags-side-head' }, [
      el('h2', { class: 'tags-side-title', text: title }),
      el('button', { class: 'btn btn-quiet', type: 'button', on: { click: function () { renderKbSide(); } } }, '返回')
    ]));
    side.appendChild(el('p', { class: 'tags-side-note', text: '正在取全文…' }));
    fetch('/api/kb/item?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (item) {
      side.textContent = '';
      var meta = item.meta || {};
      var doc = item.document || '';
      var lines = doc.split('\n');
      var t = meta.title || (lines[0] || title);
      var sum = lines[1] || '';
      var body = lines.slice(2).join('\n').trim();
      side.appendChild(el('div', { class: 'tags-side-head' }, [
        el('h2', { class: 'tags-side-title', text: t }),
        el('button', {
          class: 'btn btn-quiet', type: 'button',
          on: { click: function () { renderKbSide(); } }
        }, '返回')
      ]));
      if (sum) side.appendChild(el('p', { class: 'tags-side-note', text: sum }));
      if (body) side.appendChild(el('p', { class: 'tags-side-body', text: body }));
      if (meta.source) side.appendChild(el('p', { class: 'tags-side-src', text: meta.source }));
      var jumps = kbJumpButtons(meta.cardId, { session: meta.session });
      if (jumps.length) side.appendChild(el('div', { class: 'kb-detail-actions' }, jumps));
      if (meta.session || meta.source) {
        side.appendChild(el('div', { class: 'kb-detail-actions' }, [
          el('button', {
            class: 'btn btn-quiet', type: 'button',
            on: { click: function () { locateFromEntry(id); } }
          }, '看现场原文')
        ]));
      }
    }).catch(function () {
      side.appendChild(el('p', { class: 'tags-side-note', text: '取不到全文，知识库服务可能没起。' }));
    });
  }

  /* ── 每周温故 ─────────────────────────────────────────── */

  function checkWeekly(force) {
    if (state.weeklyLoading) return;
    state.weeklyLoading = true;
    var forceQ = force || /(?:^|[?&])weekly=force(?:&|$)/.test(window.location.search);
    fetch('/api/weekly' + (forceQ ? '?force=1' : '')).then(function (r) { return r.json(); }).then(function (d) {
      state.weeklyLoading = false;
      if (!d || !d.show) return;
      state.weekly = d;
      state.weeklyWarm = true;
      renderWeeklyModal();
    }).catch(function () { state.weeklyLoading = false; });
  }

  function renderWeeklyModal() {
    var d = state.weekly;
    if (!d) return;
    var old = document.querySelector('.weekly-modal');
    if (old) old.remove();

    var body = el('div', { class: 'weekly-body', id: 'weekly-body' });
    var overlay = el('div', { class: 'kb-modal weekly-modal', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'kb-modal-in weekly-in' }, [
        el('div', { class: 'weekly-head' }, [
          el('div', {}, [
            el('div', { class: 'kicker' }, '上周温故'),
            el('h2', { text: '第 ' + d.week.key.split('-W')[1] + ' 周 · 温故' })
          ]),
          el('button', { class: 'btn btn-quiet', type: 'button', on: { click: function () { closeWeekly(true); } } }, '关闭')
        ]),
        el('p', { class: 'weekly-meta', text: d.week.start + ' → ' + d.week.end + ' · 涉及 ' + d.stats.cards + ' 张卡 · 做了 ' + d.stats.quizzes + ' 道题 · 答对 ' + d.stats.correct + '/' + d.stats.quizzes }),
        el('label', { class: 'weekly-toggle' }, [
          el('input', {
            type: 'checkbox', checked: state.weeklyWarm ? true : null,
            on: {
              change: function (ev) {
                state.weeklyWarm = ev.target.checked;
                paintWeeklyBody(body);
              }
            }
          }),
          el('span', { text: '温故模式（默认开）' }),
          el('em', { text: '开：看这周的卡 + 只含这些卡的标签网络；关：只看数字' })
        ]),
        body,
        el('div', { class: 'weekly-foot' }, [
          d.cards.length ? el('button', {
            class: 'btn btn-primary', type: 'button',
            on: {
              click: function () {
                var id = d.cards[0].id;
                closeWeekly(true);
                go('#deck/' + encodeURIComponent(id));
              }
            }
          }, '开始温故') : null,
          el('button', { class: 'btn btn-ghost', type: 'button', on: { click: function () { closeWeekly(true); } } }, '知道了')
        ])
      ])
    ]);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeWeekly(true); });
    document.body.appendChild(overlay);
    paintWeeklyBody(body);
  }

  function paintWeeklyBody(body) {
    var d = state.weekly;
    if (!body || !d) return;
    body.textContent = '';
    if (!state.weeklyWarm) {
      body.appendChild(el('p', { class: 'weekly-note', text: '温故模式已关闭。打开它，才会显示这一周的卡片和标签网络。' }));
      return;
    }
    if (!d.cards.length) {
      body.appendChild(el('p', { class: 'weekly-note', text: '这一周没有记录。先翻一张卡，下周这里就有东西了。' }));
      return;
    }
    var cards = el('div', { class: 'weekly-cards' });
    d.cards.forEach(function (c) {
      var stat = c.quiz ? '答对 ' + c.correct + '/' + c.quiz : (c.taught ? '这周学的' : '看过');
      cards.appendChild(el('button', {
        class: 'weekly-card', type: 'button',
        on: { click: function () { closeWeekly(true); go('#deck/' + encodeURIComponent(c.id)); } }
      }, [
        el('b', { text: c.title }),
        el('span', { text: stat + (c.project ? ' · ' + c.project : '') })
      ]));
    });
    body.appendChild(el('div', { class: 'weekly-sec' }, [
      el('span', { class: 'weekly-sec-title', text: '这一周的卡片' }),
      el('span', { class: 'weekly-sec-hint', text: '点一张回去看' })
    ]));
    body.appendChild(cards);
    if (d.tags && d.tags.nodes && d.tags.nodes.length) {
      body.appendChild(el('div', { class: 'weekly-sec' }, [
        el('span', { class: 'weekly-sec-title', text: '只含这些卡片的标签' } ),
        el('span', { class: 'weekly-sec-hint', text: d.tags.nodes.length + ' 个词 · ' + (d.tags.links || []).length + ' 条连线' })
      ]));
      var cv = el('canvas', { class: 'weekly-tags', width: '640', height: '360', 'aria-label': '本周标签网络' });
      body.appendChild(cv);
      window.requestAnimationFrame(function () { drawWeeklyTags(cv, d.tags); });
    }
  }

  function drawWeeklyTags(cv, tags) {
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var nodes = tags.nodes || [], links = tags.links || [];
    ctx.clearRect(0, 0, W, H);
    if (!nodes.length) return;
    var byId = {};
    nodes.forEach(function (n, i) {
      var ang = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
      var rad = Math.min(W, H) * (nodes.length <= 2 ? 0.13 : 0.30);
      n.x = W / 2 + Math.cos(ang) * rad;
      n.y = H / 2 + Math.sin(ang) * rad;
      byId[n.id] = n;
    });
    // 两轮轻量弹簧，让相连的靠近、不相连的散开
    for (var it = 0; it < 80; it++) {
      for (var i = 0; i < nodes.length; i++) {
        for (var j = i + 1; j < nodes.length; j++) {
          var a = nodes[i], b = nodes[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
          var f = 1600 / (d * d); dx /= d; dy /= d;
          a.x -= dx * f; a.y -= dy * f; b.x += dx * f; b.y += dy * f;
        }
      }
      links.forEach(function (l) {
        var a = byId[l.s], b = byId[l.t];
        if (!a || !b) return;
        var dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
        var k = (d - 90) * 0.012 * (l.w || 1); dx /= d; dy /= d;
        a.x += dx * k; a.y += dy * k; b.x -= dx * k; b.y -= dy * k;
      });
      nodes.forEach(function (n) { n.x = Math.max(50, Math.min(W - 50, n.x)); n.y = Math.max(40, Math.min(H - 40, n.y)); });
    }
    // 风格和「知识地图 · 标签网络」对齐：点按项目色、半径随条数、标签贴点正下方
    links.forEach(function (l) {
      var a = byId[l.s], b = byId[l.t];
      if (!a || !b) return;
      ctx.strokeStyle = C.link;
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });
    nodes.forEach(function (n) {
      var r = 4 + n.n * 1.7;
      n._r = r;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7);
      ctx.fillStyle = n.c || C.accent;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    var placed = [];
    function overlapsDot(b, n) {
      var cx = Math.max(b.x1, Math.min(n.x, b.x2));
      var cy = Math.max(b.y1, Math.min(n.y, b.y2));
      return Math.hypot(n.x - cx, n.y - cy) < n._r + 2;
    }
    function overlapsBox(a, b) { return !(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1); }
    nodes.slice().sort(function (a, b) { return b.n - a.n; }).forEach(function (n) {
      var best = null, bestScore = 1e9;
      var sizes = [11, 10.5, 10, 9.5, 9, 8.5];
      for (var si = 0; si < sizes.length; si++) {
        var size = sizes[si];
        ctx.font = size + 'px "PingFang SC", sans-serif';
        var w = ctx.measureText(n.id).width;
        var dys = [n._r + 12, n._r + 10, n._r + 14, n._r + 9, n._r + 16];
        for (var di = 0; di < dys.length; di++) {
          var dy = dys[di];
          var b = { x1: n.x - w / 2, x2: n.x + w / 2, y1: n.y + dy - size, y2: n.y + dy + 3 };
          var score = 0;
          nodes.forEach(function (o) { if (o !== n && overlapsDot(b, o)) score += 1; });
          placed.forEach(function (p) { if (overlapsBox(b, p)) score += 1; });
          if (b.x1 < 2 || b.x2 > W - 2 || b.y2 > H - 2) score += 2;
          if (score < bestScore) { bestScore = score; best = { b: b, size: size }; }
          if (score === 0) break;
        }
        if (best && bestScore === 0) break;
      }
      if (best) {
        placed.push(best.b);
        ctx.font = best.size + 'px "PingFang SC", sans-serif';
        ctx.lineWidth = 3.5; ctx.strokeStyle = C.mapHalo;
        var cx = (best.b.x1 + best.b.x2) / 2, cy = best.b.y2 - 3;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.strokeText(n.id, cx, cy);
        ctx.fillStyle = C.ink;
        ctx.fillText(n.id, cx, cy);
      }
    });
    ctx.textBaseline = 'alphabetic';    ctx.textBaseline = 'alphabetic';
  }

  function closeWeekly(mark) {
    var overlay = document.querySelector('.weekly-modal');
    if (overlay) overlay.remove();
    var d = state.weekly;
    state.weekly = null;
    if (mark && d && d.week && d.week.key) {
      fetch('/api/weekly/seen', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ week: d.week.key })
      }).catch(function () {});
    }
  }

    /* ── 回到现场（读本地会话日志） ───────────────────────── */

  function openLocate(q) {
    q = q || {};
    if (!q.session) {
      window.alert('这条知识没有会话锚点，回不到现场。');
      return;
    }
    var note = el('p', { class: 'kb-modal-note', text: '正在读会话日志…' });
    var body = el('div', { class: 'kb-modal-body' });
    var closeBtn = el('button', {
      class: 'btn btn-quiet', type: 'button',
      on: { click: function () { overlay.remove(); } }
    }, '关闭');
    var overlay = el('div', { class: 'kb-modal', role: 'dialog', 'aria-modal': 'true' }, [
      el('div', { class: 'kb-modal-in' }, [
        el('div', { class: 'kb-modal-head' }, [el('b', { text: '回到现场' }), closeBtn]),
        note, body
      ])
    ]);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    var params = '?session=' + encodeURIComponent(q.session) + '&seq=' + encodeURIComponent(q.seq || '');
    if (q.quote) params += '&quote=' + encodeURIComponent(q.quote);
    fetch('/api/locate' + params).then(function (r) { return r.json(); }).then(function (d) {
      note.textContent = d.ok
        ? '会话 ' + d.session + (d.anchored ? ' · 锚点 seq ' + d.seq : ' · 没记锚点，按' + (q.quote ? '引文' : '最近消息') + '定位') + (q.quote ? (d.quoteFound ? ' · 引文已命中' : ' · 引文没在前后几条里找到') : '')
        : (d.error || '没取到现场');
      (d.messages || []).forEach(function (m) {
        body.appendChild(el('div', { class: 'kb-msg' + (m.hit ? ' is-hit' : '') }, [
          el('div', { class: 'kb-msg-head' }, [
            el('span', { class: 'kb-msg-who', text: m.role === 'user' ? '你' : '助手' }),
            el('span', { text: 'seq ' + m.seq + (m.turn ? ' · 第 ' + m.turn + ' 轮' : '') })
          ]),
          el('p', { class: 'kb-msg-text', text: m.text })
        ]));
      });
      if (!d.ok) note.className = 'kb-modal-note is-bad';
    }).catch(function (err) {
      note.textContent = '取不到：' + String(err && err.message || err);
      note.className = 'kb-modal-note is-bad';
    });
  }

  function renderLine() {
    var wrap = el('section', { class: 'view view-line' });
    wrap.appendChild(renderHero({
      kicker: '04 / 一条线',
      title: '一条线，是从哪读到哪',
      lede: '只有真有前置关系的才排成串；没连上的单独放在后面，不硬凑顺序。',
      note: '四条线是四个问句，不是四门课。'
    }));

    var laneKey = LANES[state.lineLane] ? state.lineLane : 'mechanism';
    var lane = LANES[laneKey];

    var grid = el('div', { class: 'lane-grid' }, LANE_ORDER.map(function (key) {
      var on = key === laneKey;
      return el('button', {
        class: 'lane-card' + (on ? ' is-on' : ''),
        type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        on: { click: function () { go('#line/' + key); } }
      }, [
        el('span', { class: 'n', text: LANES[key].name }),
        el('span', { class: 'q', text: LANES[key].question })
      ]);
    }));
    wrap.appendChild(grid);

    wrap.appendChild(el('div', { class: 'line-question' }, [
      el('div', {}, [
        el('div', { class: 'kicker' }, '这条线在问'),
        el('h2', { class: 'line-q', text: lane.question })
      ]),
      el('p', { class: 'line-gift', text: lane.gift })
    ]));

    var concepts = state.bundle.concepts.filter(function (concept) { return concept.lane === laneKey; });
    if (!concepts.length) {
      wrap.appendChild(emptyPanel('这条线还没有概念。', '等第一张卡出现，这里会开始排队。'));
      return wrap;
    }

    var laneIds = {};
    concepts.forEach(function (concept) { laneIds[concept.id] = true; });
    var groups = buildChains(concepts, state.bundle.edges);
    var path = el('ol', { class: 'path' });
    var counter = 0;

    function whyText(concept, segNodes, i, loose) {
      if (loose) return '还没有前置关系，可以随时看。';
      if (i === 0) return '这段的起点。';
      var prev = segNodes[i - 1];
      var edge = state.bundle.edges.filter(function (e) {
        return e.kind === 'prereq' && e.to === concept.id && e.from === prev.id;
      })[0] || state.bundle.edges.filter(function (e) {
        return e.kind === 'prereq' && e.to === concept.id && segNodes.slice(0, i).some(function (n) { return n.id === e.from; });
      })[0];
      if (!edge) return '这段的起点。';
      return '上一站「' + state.bundle.conceptMap[edge.from].name + '」先讲：' + edge.reason;
    }

    function relChips(concept) {
      var rels = state.bundle.edges.filter(function (e) {
        return e.kind !== 'prereq' && (e.from === concept.id || e.to === concept.id);
      }).slice(0, 3);
      if (!rels.length) return null;
      return el('div', { class: 'rel-chips' }, rels.map(function (e) {
        var otherId = e.from === concept.id ? e.to : e.from;
        var other = state.bundle.conceptMap[otherId];
        return el('span', { class: 'rel-chip', text: KIND[e.kind].name + ' · ' + (other ? other.name : otherId) });
      }));
    }

    function station(concept, segNodes, i, loose) {
      counter += 1;
      var cards = state.bundle.cards.filter(function (card) { return card.conceptId === concept.id; });
      var cardRow = el('div', { class: 'path-cards' });
      if (cards.length) {
        cards.forEach(function (card) {
          cardRow.appendChild(el('button', {
            class: 'path-card',
            type: 'button',
            on: { click: function () { go('#deck/' + encodeURIComponent(card.id)); } }
          }, [
            el('span', { class: 'path-card-lane', text: laneName(card.lane) }),
            el('span', { class: 'path-card-title', text: card.title })
          ]));
        });
      } else {
        cardRow.appendChild(el('span', { class: 'path-empty', text: '这个词还没有卡。' }));
      }
      return el('li', { class: 'path-stop' + (loose ? ' is-loose' : '') }, [
        el('div', { class: 'path-no' + (loose ? ' is-dot' : ''), text: loose ? '·' : pad2(counter) }),
        el('div', { class: 'path-body' }, [
          el('div', { class: 'path-meta' }, loose ? [
            concept.problem || concept.domain
          ] : [
            concept.domain,
            concept.problem ? el('span', { class: 'crumb-sep', text: ' / ' }) : null,
            concept.problem || null
          ]),
          el('h3', { class: 'path-title', text: concept.name }),
          el('p', { class: 'path-desc', text: concept.desc }),
          externalPre(concept),
          el('p', { class: 'path-why' }, [el('b', {}, '为什么排在这'), whyText(concept, segNodes, i, loose)]),
          relChips(concept),
          cardRow
        ])
      ]);
    }

    function externalPre(concept) {
      var exts = state.bundle.edges.filter(function (e) {
        return e.kind === 'prereq' && e.to === concept.id && !laneIds[e.from] && state.bundle.conceptMap[e.from];
      });
      if (!exts.length) return null;
      return el('p', { class: 'path-ext' }, [
        el('b', {}, '先看另一条线：'),
        exts.map(function (e, idx) {
          var from = state.bundle.conceptMap[e.from];
          return el('span', {}, [
            idx ? '；' : '',
            el('a', {
              href: '#line/' + from.lane,
              on: { click: function (ev) { ev.preventDefault(); go('#line/' + from.lane); } }
            }, from.name + '（' + laneName(from.lane) + '）'),
            '：' + e.reason
          ]);
        })
      ]);
    }

    groups.chains.forEach(function (chain, ci) {
      if (ci > 0) {
        path.appendChild(el('li', { class: 'path-break' }, [
          el('b', { text: '另一段' }),
          el('span', { text: '和上面没有先后，可以跳着看' })
        ]));
      }
      counter = 0;
      chain.forEach(function (concept, i) { path.appendChild(station(concept, chain, i, false)); });
    });

    if (groups.solos.length) {
      path.appendChild(el('li', { class: 'path-break' }, [
        el('b', { text: '还没连成串' }),
        el('span', { text: '这些概念之间还没有前置关系，不硬排先后' })
      ]));
      var lastDomain = null;
      groups.solos.forEach(function (concept) {
        if (concept.domain !== lastDomain) {
          lastDomain = concept.domain;
          path.appendChild(el('li', { class: 'path-group', text: concept.domain }));
        }
        path.appendChild(station(concept, [], -1, true));
      });
    }

    wrap.appendChild(path);

    if (concepts.length === 1) {
      wrap.appendChild(el('p', { class: 'line-tail', text: '这条线现在只有一个概念。等第二张卡出现，顺序会自己长出来。' }));
    } else {
      wrap.appendChild(el('p', { class: 'line-tail', text: '线到这里。出现新的前置关系时会自动接上，没接上的不会被排进队。' }));
    }

    return wrap;
  }

  function buildChains(concepts, edges) {
    var byId = {};
    var index = {};
    concepts.forEach(function (c, i) { byId[c.id] = c; index[c.id] = i; });
    var parent = {};
    concepts.forEach(function (c) { parent[c.id] = c.id; });
    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    edges.forEach(function (e) {
      if (e.kind !== 'prereq' || !byId[e.from] || !byId[e.to]) return;
      var a = find(e.from);
      var b = find(e.to);
      if (a !== b) parent[a] = b;
    });
    var comps = {};
    concepts.forEach(function (c) {
      var k = find(c.id);
      (comps[k] = comps[k] || []).push(c);
    });
    var chains = [];
    var solos = [];
    Object.keys(comps).forEach(function (k) {
      var list = comps[k];
      if (list.length === 1) solos.push(list[0]);
      else chains.push(orderByPrereq(list, edges));
    });
    chains.sort(function (a, b) { return index[a[0].id] - index[b[0].id]; });
    solos.sort(function (a, b) { return index[a.id] - index[b.id]; });
    return { chains: chains, solos: solos };
  }

  function orderByPrereq(concepts, edges) {
    var byId = {};
    var order = {};
    concepts.forEach(function (concept, i) {
      byId[concept.id] = concept;
      order[concept.id] = i;
    });

    var indegree = {};
    var adj = {};
    concepts.forEach(function (concept) {
      indegree[concept.id] = 0;
      adj[concept.id] = [];
    });

    edges.forEach(function (edge) {
      if (edge.kind !== 'prereq') return;
      if (!byId[edge.from] || !byId[edge.to]) return;
      adj[edge.from].push(edge.to);
      indegree[edge.to] += 1;
    });

    var available = concepts.filter(function (concept) { return indegree[concept.id] === 0; });
    var result = [];
    while (available.length) {
      available.sort(function (a, b) { return order[a.id] - order[b.id]; });
      var next = available.shift();
      result.push(next);
      adj[next.id].forEach(function (to) {
        indegree[to] -= 1;
        if (indegree[to] === 0 && byId[to]) available.push(byId[to]);
      });
    }

    if (result.length < concepts.length) {
      concepts.forEach(function (concept) {
        if (result.indexOf(concept) === -1) result.push(concept);
      });
    }
    return result;
  }

  /* ── 启动 ─────────────────────────────────────────────── */

  init();
})();
