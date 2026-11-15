#!/usr/bin/env python3
"""把知识条目按「来源文件」聚成代码地图。

思路：每条知识的 source 里有 session=… 与 #seq=…；去对应的 DSH 会话日志里，
取锚点附近的工具调用，抽出被读/被改的 file_path，最近的权重最高。
一条知识最多挂 2 个文件；抽不到就进 unlocated，不硬编。

输出：app/data/kb-code-map.json
"""
import json, os, re, subprocess, sys, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # app/
PROJ = os.path.dirname(ROOT)
DOC = os.path.join(PROJ, "doc.md")
OUT = os.path.join(ROOT, "data", "kb-code-map.json")
DSH_HOME = os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")
HOME = os.path.expanduser("~")
ALLOW_EXT = {".mjs", ".js", ".jsx", ".ts", ".tsx", ".py", ".json", ".md", ".html",
             ".css", ".swift", ".sh", ".command", ".toml", ".yml", ".yaml", ".bat", ".ps1"}
SKIP = ("/node_modules/", "/.venv/", "/site-packages/", "/.git/", "/dist/", "/build/",
        "/tmp/", "/private/tmp/", "/Library/", "/.cache/", "/__pycache__/")
PATH_KEYS = ("file_path", "path", "target_file", "filePath")


def parse_doc():
    text = open(DOC, encoding="utf-8").read()
    blocks = re.split(r"(?m)^### ", text)[1:]
    entries = []
    for b in blocks:
        mid = re.search(r"\*\*ID\*\*：(.+)", b)
        if not mid:
            continue
        title = b.split("\n", 1)[0].strip()
        title = re.sub(r"^\d+\s*", "", title)
        mt = re.search(r"\*\*一句话\*\*：(.+)", b)
        ms = re.search(r"\*\*来源\*\*：([^\n]+)", b)
        ml = re.search(r"\*\*学习线\*\*：([^\u3000\n]+)", b)
        source = (ms.group(1).strip() if ms else "")
        proj = source.split(" · ")[0].strip() if " · " in source else ""
        session = re.search(r"session=([\w.-]+)", source)
        seq = re.search(r"#seq=([\d,]+)", source)
        entries.append({
            "id": mid.group(1).strip(),
            "source": source,
            "title": title,
            "summary": (mt.group(1).strip() if mt else ""),
            "project": proj,
            "session": session.group(1) if session else "",
            "seq": int(seq.group(1).split(",")[0]) if seq else 0,
            "lane": (ml.group(1).strip() if ml else ""),
        })
    return entries


def session_index():
    idx = {}
    root = os.path.join(DSH_HOME, "sessions")
    if not os.path.isdir(root):
        return idx
    for ws in os.listdir(root):
        wsdir = os.path.join(root, ws)
        if not os.path.isdir(wsdir):
            continue
        for s in os.listdir(wsdir):
            sdir = os.path.join(wsdir, s)
            if not os.path.isdir(sdir):
                continue
            for f in os.listdir(sdir):
                if re.match(r"^session.*\.jsonl\.zstd$", f):
                    idx[s] = os.path.join(sdir, f)
    return idx


def read_log(path):
    try:
        raw = subprocess.run(["zstd", "-dc", "--", path], capture_output=True, check=True).stdout
    except Exception:
        return []
    rows = []
    for line in raw.decode("utf-8", "replace").split("\n"):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    return rows


def norm_path(p):
    if not p or not isinstance(p, str):
        return ""
    p = p.strip().strip('"\'')
    if p.startswith("file://"):
        p = p[7:]
    if not p.startswith("/"):
        return ""
    if os.path.splitext(p)[1].lower() not in ALLOW_EXT:
        return ""
    if any(x in p for x in SKIP):
        return ""
    if p.startswith(ROOT):
        return os.path.relpath(p, ROOT)
    if p.startswith(PROJ + os.sep):
        return os.path.relpath(p, PROJ)
    if p.startswith(HOME + os.sep):
        rel = os.path.relpath(p, HOME)
        # 配置/缓存不算代码地图
        if rel.startswith(".dsh/") or rel.startswith("Library/") or rel.startswith("."):
            return ""
        return "~/" + rel
    return ""


def project_of(p):
    q = p[2:] if p.startswith("~/") else p
    parts = q.split("/")
    if parts and parts[0].startswith("文件"):
        # ~/文件/006 Code/<项目>/…
        if len(parts) > 2 and re.match(r"^\d{3}", parts[1]):
            return parts[2]
        return parts[0]
    if parts and parts[0] == "Documents" and len(parts) > 2 and parts[1] == "deepseek-harness":
        if parts[2] == "default-workspace":
            if len(parts) > 4 and parts[3] == "plugins":
                return parts[4]
            return parts[3] if len(parts) > 3 else parts[2]
        return parts[2]
    return parts[0] if parts else ""


def pick_files(events, seq0):
    """events: [(seq, [paths...])]；按与锚点的距离加权，取前 2。"""
    score = collections.Counter()
    for seq, paths in events:
        d = abs(seq - seq0) if seq0 else 0
        w = 3 if d <= 40 else 2 if d <= 120 else 1 if d <= 300 else 0.3
        for p in set(paths):
            score[p] += w
    return [(p, round(s, 1)) for p, s in score.most_common(2) if s >= 0.9]


def main():
    entries = parse_doc()
    idx = session_index()
    print(f"知识 {len(entries)} 条 · 会话 {len(idx)} 个")

    by_session = collections.defaultdict(list)
    for e in entries:
        if e["session"]:
            by_session[e["session"]].append(e)

    files_of = {}
    for sid, items in by_session.items():
        cand = [k for k in idx if k.startswith(sid)]
        if not cand:
            continue
        cand.sort(key=len)
        path = idx[cand[0]]
        events = []
        for ev in read_log(path):
            if ev.get("type") != "tool/call":
                continue
            seq = ev.get("seq", 0)
            try:
                args = json.loads((ev.get("data") or {}).get("arguments") or "{}")
            except Exception:
                continue
            paths = []
            for k in PATH_KEYS:
                if isinstance(args.get(k), str):
                    np = norm_path(args[k])
                    if np:
                        paths.append(np)
            cmd = args.get("command")
            if isinstance(cmd, str):
                for m in re.findall(r"(/Users/[\w./\- \u4e00-\u9fa5]+\.(?:mjs|js|ts|py|json|md|html|css|swift|sh|command|toml))", cmd):
                    np = norm_path(m)
                    if np:
                        paths.append(np)
            if paths:
                events.append((seq, paths))
        for e in items:
            files_of[e["id"]] = pick_files(events, e["seq"])

    files = collections.defaultdict(lambda: {"path": "", "project": "", "entries": []})
    unlocated = []
    for e in entries:
        fs = files_of.get(e["id"]) or []
        if not fs:
            unlocated.append({"id": e["id"], "title": e["title"], "project": e["project"], "lane": e["lane"]})
            continue
        for p, s in fs:
            rec = files[p]
            rec["path"] = p
            rec["project"] = project_of(p)
            rec["entries"].append({"id": e["id"], "title": e["title"], "lane": e["lane"], "project": e["project"], "source": e.get("source", ""), "score": s})

    out = {
        "generatedAt": int(__import__("time").time() * 1000),
        "files": sorted(files.values(), key=lambda r: (-len(r["entries"]), r["path"])),
        "unlocated": unlocated,
    }
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"文件 {len(out['files'])} 个 · 定位 {sum(len(f['entries']) for f in out['files'])} 条 · 未定位 {len(unlocated)} 条 -> {OUT}")


if __name__ == "__main__":
    main()
