#!/usr/bin/env python3
"""
講義フレームワークのビルド・検証ツール（Python 標準ライブラリのみ）

    python tools/build.py              教材を検証して結果を表示（lectures/catalog.json も更新）
    python tools/build.py --check      検証のみ（エラーがあれば終了コード 1。CI 用）
    python tools/build.py --out _site  GitHub Pages で公開するフォルダを作る（アプリ＋教材。公開リポジトリ用）
    python tools/build.py --out _site --app-only --content-out _content
                                       非公開リポジトリ用：_site はアプリ本体だけ（教材なし）、
                                       _content は教材（catalog.json と配信ファイル）。_content は
                                       GitHub Actions が同じリポジトリの dist ブランチに置き、iPad は
                                       GitHub API からアクセストークンで取得する。

教材一覧（catalog.json）の内容：
  講義ごとに ID・タイトル・科目・年度・版（version = ファイル内容のハッシュ）・
  ダウンロードするファイルの一覧（パス・サイズ・SHA-256）。
  iPad のアプリはこれを読んで、新しい教材・更新された教材を検出し、ファイルをすべて取得する。

公開されるもの（--out）：
  アプリ本体（index.html, lecture.html, manifest.webmanifest, sw.js, assets/, core/, vendor/）と、
  各講義の「配信ファイル」だけ（下の collect_files を参照）。tests/, tools/, *.md の説明書、
  講義フォルダ内の参照されていないファイル（下書き・元の PowerPoint 等）は公開されない。
"""
import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
CONTENT = 'lectures'                     # アプリと一緒に公開する教材（デモ・テスト用）。公開時は <アプリ>/lectures/
COURSES = 'courses'                      # 実際の授業の教材（別の非公開リポジトリ。開発用サーバでは lectures/ と合わせて表示）
CATALOG = 'catalog.json'
SITE_JSON = 'site.json'                  # lectures/site.json（任意）：ライブラリのタイトル・科目の並び順
APP_ENTRIES = ['index.html', 'lecture.html', 'manifest.webmanifest', 'assets', 'core', 'vendor']
SW_FILE = 'sw.js'
SKIP_NAMES = {'.DS_Store', 'Thumbs.db', 'desktop.ini', CATALOG}
SECRET_PATTERNS = ['.env', '.env.*', '*.pem', 'id_rsa*', 'credentials*.json', '*.p12', '*.keystore', 'settings.local.json']
MAX_FILE_BYTES = 95 * 1024 * 1024        # GitHub の 1 ファイル上限（100MB）未満
WARN_FILE_BYTES = 30 * 1024 * 1024
PAGE_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.\-]*$')
LECTURE_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.\-/]*$')


# ---------------------------------------------------------------
# ファイル・ハッシュ
# ---------------------------------------------------------------
_hash_cache = {}


def sha256(path: Path) -> str:
    st = path.stat()
    key = (str(path), st.st_mtime_ns, st.st_size)
    h = _hash_cache.get(key)
    if h is None:
        d = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                d.update(chunk)
        h = d.hexdigest()
        _hash_cache[key] = h
    return h


def skip_name(name: str) -> bool:
    return name.startswith('.') or name in SKIP_NAMES


def iter_files(base: Path):
    """base 以下のファイル（隠しファイルを除く）を相対パス順に"""
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if not skip_name(d))
        for fn in sorted(filenames):
            if not skip_name(fn):
                out.append(Path(dirpath) / fn)
    return out


def rel(path: Path, base: Path) -> str:
    return path.relative_to(base).as_posix()


def short_hash(text: str, n=12) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:n]


# ---------------------------------------------------------------
# アプリ本体（Service Worker が端末に保存するファイル）
# ---------------------------------------------------------------
def app_files():
    files = []
    for entry in APP_ENTRIES:
        p = ROOT / entry
        if p.is_file():
            files.append(p)
        elif p.is_dir():
            files.extend(iter_files(p))
    return [(rel(f, ROOT), sha256(f)[:16]) for f in files]


def app_version(files):
    return short_hash('\n'.join(f'{p}:{h}' for p, h in files))


def render_sw(dev: bool, extra=()) -> str:
    """sw.js にアプリの版とファイル一覧を埋め込む（extra：公開フォルダだけにある追加ファイル）"""
    files = sorted(app_files() + list(extra))
    build = {'version': app_version(files), 'files': files, 'dev': dev}
    src = (ROOT / SW_FILE).read_text(encoding='utf-8')
    return re.sub(r'/\*BUILD\*/.*?/\*END\*/', lambda m: '/*BUILD*/' + json.dumps(build, ensure_ascii=False, separators=(',', ':')) + '/*END*/',
                  src, count=1, flags=re.S)


# ---------------------------------------------------------------
# lecture.md の解析（core/content/markdown.js と同じ規則の簡易版）
# ---------------------------------------------------------------
def scalar(v: str):
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
        return v[1:-1]
    if v == 'true':
        return True
    if v == 'false':
        return False
    if re.fullmatch(r'-?\d+(\.\d+)?', v):
        return float(v) if '.' in v else int(v)
    return v


def parse_front_matter(text: str):
    text = text.lstrip('﻿').replace('\r\n', '\n').replace('\r', '\n')
    m = re.match(r'---[ \t]*\n(.*?)\n---[ \t]*(?:\n|$)', text, re.S)
    if not m:
        return {}, text
    meta, parent = {}, None
    for raw in m.group(1).split('\n'):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if raw[:1].isspace() and parent:
            if line.startswith('- '):
                if not isinstance(meta.get(parent), list):
                    meta[parent] = []
                meta[parent].append(scalar(line[2:].strip()))
            elif ':' in line:
                k, v = line.split(':', 1)
                if not isinstance(meta.get(parent), dict):
                    meta[parent] = {}
                meta[parent][k.strip()] = scalar(v.strip())
            continue
        if ':' not in line:
            continue
        k, v = line.split(':', 1)
        k, v = k.strip(), v.strip()
        if v == '':
            parent, meta[k] = k, None
        else:
            parent, meta[k] = None, scalar(v)
    return meta, text[m.end():]


FENCE_RE = re.compile(r'^ {0,3}(`{3,}|~{3,})')
ARGS_RE = re.compile(r'''([A-Za-z_][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))|"([^"]*)"|'([^']*)'|(\S+)''')


def parse_args(s: str):
    out = {'_': []}
    for m in ARGS_RE.finditer(s or ''):
        if m.group(1):
            v = m.group(2) if m.group(2) is not None else m.group(3) if m.group(3) is not None else m.group(4)
            out[m.group(1)] = scalar(v) if m.group(4) is not None else v
        else:
            out['_'].append(next(g for g in (m.group(5), m.group(6), m.group(7)) if g is not None))
    return out


def split_pages(body: str):
    out, cur, fence, in_math = [], [], None, False
    for line in body.split('\n'):
        f = FENCE_RE.match(line)
        if f and not in_math:
            fence = (None if line.strip().startswith(fence) else fence) if fence else f.group(1)
        elif not fence and line.count('$$') % 2 == 1:
            in_math = not in_math
        if not fence and not in_math and re.fullmatch(r'---\s*', line):
            out.append(cur)
            cur = []
        else:
            cur.append(line)
    out.append(cur)
    return out


def parse_pages(body: str):
    """[{opts, pdf, widgets:[name], lines:[(text, in_fence)]}]"""
    pages = []
    for chunk in split_pages(body):
        opts, pdf, widgets, lines, fence = {}, None, [], [], None
        for line in chunk:
            f = FENCE_RE.match(line)
            if f:
                fence = (None if line.strip().startswith(fence) else fence) if fence else f.group(1)
            if not fence and line.startswith('@page') and re.match(r'@page\b', line):
                a = parse_args(line[5:])
                for x in a.pop('_'):
                    opts[x] = True
                opts.update(a)
            elif not fence and re.match(r'@pdf\b', line):
                pdf = parse_args(line[4:])
            else:
                if not fence:
                    m = re.match(r'@widget\s+(\S+)', line)
                    if m:
                        widgets.append(m.group(1))
                lines.append((line, bool(fence)))
        text = '\n'.join(t for t, _ in lines)
        if pdf is None and not text.strip() and not opts:
            continue
        pages.append({'opts': opts, 'pdf': pdf, 'widgets': widgets, 'lines': lines})
    return pages


# ---------------------------------------------------------------
# 参照しているファイルの収集（依存リソース）
# ---------------------------------------------------------------
def is_local_ref(u: str) -> bool:
    u = u.strip()
    return bool(u) and not re.match(r'^([a-z][\w+.\-]*:|/|#|\{|\$)', u, re.I)


def md_refs(pages):
    """本文から参照しているローカルファイル（講義フォルダからの相対 URL）"""
    refs = []
    for p in pages:
        if p['pdf'] is not None:
            f = p['pdf']['_'][0] if p['pdf']['_'] else p['pdf'].get('src')
            if f:
                refs.append(('@pdf', str(f)))
        for line, in_fence in p['lines']:
            if in_fence:
                continue
            m = re.match(r'@(image|video)\s+(\S+)(.*)$', line)
            if m:
                refs.append(('@' + m.group(1), m.group(2)))
                a = parse_args(m.group(3))
                if a.get('poster'):
                    refs.append(('poster', str(a['poster'])))
                continue
            if line.startswith('@iframe'):
                m = re.match(r'@iframe\s+(\S+)', line)
                if m and is_local_ref(m.group(1)):
                    refs.append(('@iframe', m.group(1)))
                continue
            s = re.sub(r'`[^`]*`', '', line)
            for m in re.finditer(r'!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)', s):
                refs.append(('link', m.group(1)))
            for m in re.finditer(r'\b(?:src|href|poster)\s*=\s*["\']([^"\']+)["\']', s):
                refs.append(('html', m.group(1)))
    return [(k, u.split('#')[0].split('?')[0]) for k, u in refs if is_local_ref(u)]


JS_IMPORT_RES = [
    re.compile(r'''\bimport\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]'''),
    re.compile(r'''\bimport\s*['"]([^'"]+)['"]'''),
    re.compile(r'''\bexport\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]'''),
    re.compile(r'''\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)'''),
]
JS_URL_RE = re.compile(r'''new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)''')


def js_closure(start: Path, content_root: Path, errors: list):
    """widgets.js から相対 import をたどったファイル集合（教材ルート外は不可）"""
    seen, stack = set(), [start]
    while stack:
        f = stack.pop()
        if f in seen:
            continue
        seen.add(f)
        try:
            src = f.read_text(encoding='utf-8')
        except OSError as e:
            errors.append(f'{rel(f, content_root)} を読めません: {e}')
            continue
        src_nc = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
        src_nc = re.sub(r'(^|[^:\\])//[^\n]*', r'\1', src_nc)
        targets = [m.group(1) for r in JS_IMPORT_RES for m in r.finditer(src_nc)]
        urls = [m.group(1) for m in JS_URL_RE.finditer(src_nc)]
        for t in targets + urls:
            if not t.startswith('.'):
                errors.append(f'{rel(f, content_root)}: 相対パス以外の import は使えません（オフラインで動かないため）: {t}')
                continue
            p = (f.parent / t).resolve()
            try:
                p.relative_to(content_root)
            except ValueError:
                errors.append(f'{rel(f, content_root)}: 教材フォルダの外は参照できません: {t}')
                continue
            if not p.is_file():
                errors.append(f'{rel(f, content_root)}: 参照先がありません: {t}')
                continue
            if t in targets and p.suffix in ('.js', '.mjs'):
                stack.append(p)
            else:
                seen.add(p)
    return seen


def js_exports(files):
    names = set()
    for f in files:
        try:
            src = f.read_text(encoding='utf-8')
        except OSError:
            continue
        names.update(re.findall(r'\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)', src))
        names.update(re.findall(r'\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)', src))
        for m in re.finditer(r'\bexport\s*\{([^}]*)\}', src):
            for part in m.group(1).split(','):
                part = part.strip()
                if part:
                    names.add(part.split(' as ')[-1].strip())
    return names


# ---------------------------------------------------------------
# 講義 1 件の検証と配信ファイルの決定
# ---------------------------------------------------------------
def academic_year(date: str):
    m = re.match(r'(\d{4})-(\d{1,2})', str(date or ''))
    if not m:
        return None
    y, mo = int(m.group(1)), int(m.group(2))
    return y if mo >= 4 else y - 1


def scan_lecture(folder: Path, content_root: Path):
    path = rel(folder, content_root)
    errors, warnings, info = [], [], []
    md = folder / 'lecture.md'
    text = md.read_text(encoding='utf-8')
    meta, body = parse_front_matter(text)
    pages = parse_pages(body)

    lid = str(meta.get('id') or path)
    if not LECTURE_ID_RE.match(lid):
        errors.append(f'講義 ID "{lid}" に使えない文字があります（英数字と - _ . / のみ）')
    for k in ('title', 'course'):
        if not meta.get(k):
            (errors if k == 'title' else warnings).append(f'フロントマターに {k}: がありません')
    if meta.get('date') and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', str(meta['date'])):
        warnings.append(f'date は YYYY-MM-DD で書いてください: {meta["date"]}')

    # ページ ID
    seen_ids = {}
    n_pages = 0
    for i, p in enumerate(pages, 1):
        if p['pdf'] is not None:
            pid = p['pdf'].get('id', p['opts'].get('id'))
            if pid is None:
                warnings.append(f'{i} ページ目の @pdf に id= がありません（ファイル名が接頭辞になります。ファイル名を変えると書き込みが外れます）')
            n_pages += 1
            continue
        n_pages += 1
        pid = p['opts'].get('id')
        if pid is None:
            errors.append(f'{i} ページ目に @page id=... がありません（書き込みの対応付けに必要）')
            continue
        pid = str(pid)
        if not PAGE_ID_RE.match(pid):
            errors.append(f'ページ ID "{pid}" に使えない文字があります（英数字と - _ . のみ）')
        if pid in seen_ids:
            errors.append(f'ページ ID "{pid}" が重複しています（{seen_ids[pid]} ページ目と {i} ページ目）')
        seen_ids.setdefault(pid, i)

    # ファイル
    files = {md}
    widgets_setting = meta.get('widgets')
    widgets_file = None
    if widgets_setting is not False:
        wf = folder / (widgets_setting if isinstance(widgets_setting, str) else 'widgets.js')
        if wf.is_file():
            widgets_file = wf
        elif isinstance(widgets_setting, str):
            errors.append(f'widgets: {widgets_setting} が見つかりません')
    js_files = set()
    if widgets_file:
        js_files = js_closure(widgets_file.resolve(), content_root.resolve(), errors)
        files |= {Path(f) for f in js_files}
    used_widgets = [w for p in pages for w in p['widgets']]
    if used_widgets:
        if not widgets_file:
            errors.append(f'@widget {used_widgets[0]} を使っていますが widgets.js がありません')
        else:
            exports = js_exports([widgets_file])
            for w in sorted(set(used_widgets)):
                if w not in exports:
                    errors.append(f'@widget {w}: widgets.js に export function {w}(w) がありません')

    for kind, u in md_refs(pages):
        p = (folder / u).resolve()
        try:
            p.relative_to(content_root.resolve())
        except ValueError:
            errors.append(f'{kind} {u}: 教材フォルダの外は参照できません')
            continue
        if not p.is_file():
            errors.append(f'{kind} {u}: ファイルがありません')
            continue
        files.add(p)

    media = folder / 'media'
    if media.is_dir():
        files.update(iter_files(media))
    assets = meta.get('assets') or []
    if isinstance(assets, str):
        assets = [a.strip() for a in assets.split(',') if a.strip()]
    for pat in assets:
        hits = [f for f in iter_files(folder) if fnmatch.fnmatch(rel(f, folder), str(pat))]
        if not hits:
            warnings.append(f'assets: {pat} に一致するファイルがありません')
        files.update(hits)

    files = sorted({Path(f).resolve() for f in files})
    out_files = []
    for f in files:
        rp = rel(f, content_root.resolve())
        name = f.name
        if any(fnmatch.fnmatch(name, pat) for pat in SECRET_PATTERNS):
            errors.append(f'{rp}: 認証情報らしいファイルは配信できません')
            continue
        size = f.stat().st_size
        if size > MAX_FILE_BYTES:
            errors.append(f'{rp}: {size / 1e6:.0f} MB は大きすぎます（GitHub の上限 100MB。動画は圧縮してください）')
        elif size > WARN_FILE_BYTES:
            warnings.append(f'{rp}: {size / 1e6:.0f} MB（ダウンロードに時間がかかります）')
        out_files.append({'path': rp, 'size': size, 'hash': sha256(f)})

    used = {f.resolve() for f in files}
    unused = [rel(f, folder) for f in iter_files(folder) if f.resolve() not in used and f.name != 'lecture.md']
    if unused:
        info.append('配信されないファイル（参照されていない）: ' + ', '.join(unused[:8]) + (' …' if len(unused) > 8 else ''))

    version = short_hash('\n'.join(f'{f["path"]}:{f["hash"]}' for f in out_files))
    entry = {
        'id': lid,
        'path': path,
        'title': str(meta.get('title') or path),
        'course': str(meta.get('course') or ''),
        'lecture': str(meta.get('lecture') or ''),
        'date': str(meta.get('date') or ''),
        'year': meta.get('year') if isinstance(meta.get('year'), int) else academic_year(meta.get('date')),
        'order': meta.get('order') if isinstance(meta.get('order'), (int, float)) else None,
        'note': str(meta.get('note') or ''),
        'pages': n_pages,
        'version': version,
        'size': sum(f['size'] for f in out_files),
        'files': out_files,
    }
    return {'entry': entry, 'errors': errors, 'warnings': warnings, 'info': info,
            'draft': meta.get('draft') is True, 'abs_files': files}


def find_lectures(content_root: Path):
    """lecture.md を含むフォルダ（_ や . で始まるフォルダの中は除く：_template, _test, _lib など）"""
    out = []
    for md in sorted(content_root.rglob('lecture.md')):
        parts = md.parent.relative_to(content_root).parts
        if not parts or any(x.startswith(('_', '.')) for x in parts):
            continue
        out.append(md.parent)
    return out


def git_updated(paths, cwd):
    try:
        r = subprocess.run(['git', 'log', '-1', '--format=%cI', '--', *[str(p) for p in paths]],
                           cwd=cwd, capture_output=True, text=True, timeout=20)
        return r.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def mtime_updated(paths):
    t = max(p.stat().st_mtime for p in paths)
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).astimezone().isoformat(timespec='seconds')


def build_catalog(use_git=False, content_root=None):
    """content_root：教材フォルダ（既定 lectures/。非公開リポジトリの CI では --content-dir で指定）"""
    content_root = Path(content_root or ROOT / CONTENT).resolve()
    site = {}
    sj = content_root / SITE_JSON
    if sj.is_file():
        try:
            site = json.loads(sj.read_text(encoding='utf-8'))
        except ValueError as e:
            site = {}
            print(f'警告: {SITE_JSON} を読めません: {e}', file=sys.stderr)
    reports, lectures, ids = [], [], {}
    for folder in find_lectures(content_root):
        r = scan_lecture(folder, content_root)
        e = r['entry']
        if e['id'] in ids:
            r['errors'].append(f'講義 ID "{e["id"]}" が {ids[e["id"]]} と重複しています（フロントマターの id: を変えてください）')
        ids.setdefault(e['id'], e['path'])
        e['updated'] = (git_updated(r['abs_files'], content_root) if use_git else None) or mtime_updated(r['abs_files'])
        reports.append(r)
        if not r['draft']:
            lectures.append(e)
    order = {c: i for i, c in enumerate(site.get('courses') or [])}
    lectures.sort(key=lambda e: (order.get(e['course'], len(order)), e['course'],
                                 -(e['year'] or 0), e['order'] if e['order'] is not None else 1e9, e['date'], e['path']))
    catalog = {
        'format': 'lecture-web-catalog',
        'version': 1,
        'title': site.get('title') or '講義資料',
        'subtitle': site.get('subtitle') or '',
        'demo': site.get('demo') is True,
        'courses': site.get('courses') or [],
        'generated': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'lectures': lectures,
    }
    catalog['_root'] = str(content_root)
    return catalog, reports


def print_report(reports, verbose=True):
    n_err = sum(len(r['errors']) for r in reports)
    n_warn = sum(len(r['warnings']) for r in reports)
    print(f'教材の検証: {len(reports)} 件')
    for r in reports:
        e = r['entry']
        mark = '✗' if r['errors'] else ('!' if r['warnings'] else '✓')
        extra = '（下書き：公開しない）' if r['draft'] else ''
        print(f'  {mark} {e["path"]}  {e["title"]}  [{e["pages"]} ページ・{len(e["files"])} ファイル・{e["size"] / 1024:.0f} KB・版 {e["version"]}]{extra}')
        for m in r['errors']:
            print(f'      エラー: {m}')
        for m in r['warnings']:
            print(f'      警告  : {m}')
        if verbose:
            for m in r['info']:
                print(f'      情報  : {m}')
    print(f'エラー {n_err} 件・警告 {n_warn} 件')
    return n_err


# ---------------------------------------------------------------
# 公開フォルダの作成（GitHub Pages）
# ---------------------------------------------------------------
def clean_dir(out: Path):
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)


def public_catalog(catalog):
    return {k: v for k, v in catalog.items() if not k.startswith('_')}


def copy_lectures(dst_root: Path, catalog):
    src_root = Path(catalog['_root'])
    for e in catalog['lectures']:
        for f in e['files']:
            dst = dst_root / f['path']
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_root / f['path'], dst)
    dst_root.mkdir(parents=True, exist_ok=True)
    (dst_root / CATALOG).write_text(json.dumps(public_catalog(catalog), ensure_ascii=False, indent=1), encoding='utf-8')


def dir_size(d: Path):
    return sum(f.stat().st_size for f in d.rglob('*') if f.is_file())


def build_site(out: Path, catalog, app_only=False):
    """公開フォルダ（GitHub Pages）。app_only なら教材を含めない（非公開リポジトリ用）"""
    clean_dir(out)
    for p, _ in app_files():
        dst = out / p
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / p, dst)
    extra = []
    if app_only:
        # アプリに「教材は GitHub の非公開リポジトリから取る」ことを伝える（リポジトリ名・トークンは書かない）
        cfg = out / 'app-config.json'
        cfg.write_text(json.dumps({'contentType': 'github'}, ensure_ascii=False), encoding='utf-8')
        extra.append(('app-config.json', sha256(cfg)[:16]))
    (out / SW_FILE).write_text(render_sw(dev=False, extra=extra), encoding='utf-8')
    if not app_only:
        copy_lectures(out / CONTENT, catalog)
    (out / '.nojekyll').write_text('', encoding='utf-8')
    what = 'アプリ本体のみ' if app_only else f'講義 {len(catalog["lectures"])} 件'
    print(f'公開フォルダを作成しました: {out}（{dir_size(out) / 1e6:.1f} MB、{what}）')


def build_content(out: Path, catalog):
    """教材フォルダ（非公開リポジトリの dist ブランチ用）：catalog.json と配信ファイル"""
    clean_dir(out)
    copy_lectures(out, catalog)
    (out / 'README.md').write_text(
        '# 教材（自動生成）\n\nこのブランチは GitHub Actions（tools/build.py --content-out）が main の lectures/ から作ります。'
        '直接編集しないでください。iPad のアプリが GitHub API からここの教材を取得します。\n', encoding='utf-8')
    print(f'教材フォルダを作成しました: {out}（{dir_size(out) / 1e6:.1f} MB、講義 {len(catalog["lectures"])} 件）')


def main():
    ap = argparse.ArgumentParser(description='教材の検証・教材一覧の生成・公開フォルダの作成')
    ap.add_argument('--check', action='store_true', help='検証のみ（エラーがあれば終了コード 1）')
    ap.add_argument('--out', help='公開フォルダを作る（例: _site）')
    ap.add_argument('--app-only', action='store_true', help='公開フォルダに教材を含めない（非公開リポジトリ用）')
    ap.add_argument('--content-out', help='教材フォルダを作る（非公開リポジトリの dist ブランチ用。例: _content）')
    ap.add_argument('--content-dir', help='教材のフォルダ（既定 lectures/。非公開の教材リポジトリでは courses/ やその CI のチェックアウト先）')
    ap.add_argument('--git-dates', action='store_true', help='更新日時を git の履歴から取る（--out では自動）')
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except (AttributeError, ValueError):
        pass
    catalog, reports = build_catalog(use_git=a.git_dates or bool(a.out) or bool(a.content_out),
                                     content_root=Path(a.content_dir).resolve() if a.content_dir else None)
    n_err = print_report(reports)
    if n_err:
        print('エラーを直してから公開してください。', file=sys.stderr)
        sys.exit(1)
    if a.out:
        build_site(Path(a.out).resolve(), catalog, app_only=a.app_only)
    if a.content_out:
        build_content(Path(a.content_out).resolve(), catalog)
    if not (a.out or a.content_out or a.check):
        dst = Path(catalog['_root']) / CATALOG
        dst.write_text(json.dumps(public_catalog(catalog), ensure_ascii=False, indent=1), encoding='utf-8')
        print(f'{dst} を更新しました（確認用。公開時は自動生成されます）')


if __name__ == '__main__':
    main()
