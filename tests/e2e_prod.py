#!/usr/bin/env python3
"""
本番ビルドの総合テスト（GitHub Pages と同じ配信の再現）

    pip install websocket-client          # 初回のみ
    python tests/e2e_prod.py

  1. tools/build.py --out で公開フォルダを作り、/repo/ 以下（サブディレクトリ）として配信
  2. ヘッドレス Chrome でライブラリを開き、教材をダウンロード
  3. サーバを実際に止めて（機内モード相当）ライブラリ・講義・書き込み・PDF 教材が動くか
  4. アプリの新しい版を配信 → 自動では切り替わらない（完全に閉じて起動し直しても）
     → 「アプリを更新」で切り替わり、書き込みと教材が残るか
  5. 非公開リポジトリの構成：アプリ本体だけを配信し、教材は GitHub API の代わりの模擬サーバ
     （別オリジン・トークン必須・CORS）から取得。設定の案内、トークンの誤り、自動ダウンロードして開く、
     未ダウンロードの教材は開けない、バックアップにトークンを含めない、サーバ停止後も動く
  Chrome の場所は環境変数 CHROME で指定できる。終了コード 0 = すべて成功。
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    import websocket
except ImportError:
    sys.exit('websocket-client が必要です: pip install websocket-client')

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = tempfile.mkdtemp(prefix='lw-e2e-')
SITE = os.path.join(WORK, 'site')
REPO = os.path.join(SITE, 'repo')
PORT = 8765
BASE = f'http://localhost:{PORT}/repo/'
CHROME = os.environ.get('CHROME') or next((p for p in [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
] if os.path.exists(p)), 'chrome')

# 最小の静的サーバ（GitHub Pages と同じく max-age=600 を付ける）
STATIC_SERVER = r'''
import functools, http.server, socketserver, sys
root, port = sys.argv[1], int(sys.argv[2])
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.md': 'text/markdown; charset=utf-8',
        '.json': 'application/json', '.webmanifest': 'application/manifest+json',
        '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.wasm': 'application/wasm'}
    def end_headers(self):
        self.send_header('Cache-Control', 'max-age=600')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
    def log_message(self, *a):
        pass
class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
S(('127.0.0.1', port), functools.partial(H, directory=root)).serve_forever()
'''

# GitHub API（contents / git/ref）の代わり。トークン必須・CORS・raw
MOCK_GITHUB = r'''
import http.server, json, os, socketserver, sys, urllib.parse
root, port, repo, token, sha = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
class H(http.server.BaseHTTPRequestHandler):
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Accept')
        self.send_header('Access-Control-Allow-Methods', 'GET')
    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()
    def reply(self, code, body, ctype='application/json; charset=utf-8'):
        self.send_response(code); self.cors()
        self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.headers.get('Authorization') != 'Bearer ' + token:
            return self.reply(401, b'{"message":"Bad credentials"}')
        u = urllib.parse.urlparse(self.path)
        pre = '/repos/' + repo + '/'
        if not u.path.startswith(pre):
            return self.reply(404, b'{"message":"Not Found"}')
        rest = u.path[len(pre):]
        if rest == 'git/ref/heads/dist':
            return self.reply(200, json.dumps({'ref': 'refs/heads/dist', 'object': {'sha': sha}}).encode())
        q = urllib.parse.parse_qs(u.query)
        if rest.startswith('contents/') and q.get('ref') == [sha]:
            f = os.path.join(root, urllib.parse.unquote(rest[9:]))
            if os.path.isfile(f):
                return self.reply(200, open(f, 'rb').read(), 'application/vnd.github.raw+json; charset=utf-8')
        return self.reply(404, b'{"message":"Not Found"}')
    def log_message(self, *a):
        pass
class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True
S(('127.0.0.1', port), H).serve_forever()
'''
PRIV_PORT, API_PORT = 8767, 8766
PRIV_BASE = f'http://localhost:{PRIV_PORT}/app/'
PRIV_SITE = os.path.join(WORK, 'priv-site')
PRIV_CONTENT = os.path.join(WORK, 'priv-content')
TOKEN = 'github_pat_test_token'

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)


def build():
    r = subprocess.run([sys.executable, os.path.join(PROJ, 'tools', 'build.py'), '--out', REPO],
                       capture_output=True, text=True, encoding='utf-8')
    print(r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr)
    if r.returncode != 0:
        sys.exit('ビルドに失敗しました:\n' + r.stdout + r.stderr)


def rebuild_sw_with_change():
    """アプリの 1 ファイルを変え、sw.js の版を作り直す（新しい版の配信を模擬）"""
    with open(os.path.join(REPO, 'core', 'util.js'), 'a', encoding='utf-8') as f:
        f.write('\n// build-B\n')
    files = []
    for entry in ['index.html', 'lecture.html', 'manifest.webmanifest', 'assets', 'core', 'vendor']:
        q = os.path.join(REPO, entry)
        paths = [q] if os.path.isfile(q) else [os.path.join(d, fn) for d, ds, fs in os.walk(q) for fn in fs]
        for x in paths:
            rel = os.path.relpath(x, REPO).replace('\\', '/')
            if any(part.startswith('.') for part in rel.split('/')):
                continue
            files.append((rel, hashlib.sha256(open(x, 'rb').read()).hexdigest()[:16]))
    files.sort(key=lambda t: t[0])
    version = hashlib.sha256('\n'.join(f'{a}:{b}' for a, b in files).encode()).hexdigest()[:12]
    swp = os.path.join(REPO, 'sw.js')
    src = open(swp, encoding='utf-8').read()
    build_json = json.dumps({'version': version, 'files': [list(t) for t in files], 'dev': False}, separators=(',', ':'))
    src = re.sub(r'/\*BUILD\*/.*?/\*END\*/', lambda m: '/*BUILD*/' + build_json + '/*END*/', src, count=1, flags=re.S)
    open(swp, 'w', encoding='utf-8').write(src)
    return version


server = None


def start_server():
    global server
    server = subprocess.Popen([sys.executable, '-c', STATIC_SERVER, SITE, str(PORT)])
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + 'index.html')
            return
        except Exception:
            time.sleep(0.1)


def stop_server():
    server.terminate()
    server.wait(5)


STROKE = """(() => { const v = __lw.view, r = v.pageEl.getBoundingClientRect(), s = r.width / 1024;
  const ev = (t, x, y) => v.pageEl.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7,
    pointerType: 'pen', isPrimary: true, clientX: r.left + x * s, clientY: r.top + y * s, pressure: 0.3, buttons: t === 'pointerup' ? 0 : 1 }));
  ev('pointerdown', 200, 560); for (let i = 1; i <= 20; i++) ev('pointermove', 200 + i * 10, 560); ev('pointerup', 400, 560);
  return __lw.book.flush().then(() => 1); })()"""
STATUS = "import('./core/pwa.js').then(m => m.appStatus())"


def main():
    build()
    start_server()
    prof = os.path.join(WORK, 'chrome-profile')
    proc = subprocess.Popen([CHROME, '--headless=new', '--disable-gpu', '--no-first-run', f'--user-data-dir={prof}',
                             '--window-size=1180,820', '--remote-debugging-port=9360',
                             '--remote-allow-origins=http://127.0.0.1:9360', 'about:blank'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        page = None
        for _ in range(50):
            try:
                tabs = json.load(urllib.request.urlopen('http://127.0.0.1:9360/json'))
                page = next(t for t in tabs if t['type'] == 'page')
                break
            except Exception:
                time.sleep(0.2)
        ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=120, suppress_origin=True)
        mid = [0]

        def call(method, **params):
            mid[0] += 1
            ws.send(json.dumps({'id': mid[0], 'method': method, 'params': params}))
            while True:
                m = json.loads(ws.recv())
                if m.get('method') == 'Runtime.exceptionThrown':
                    print('  [exception]', m['params']['exceptionDetails'].get('exception', {}).get('description', '')[:300])
                if m.get('id') == mid[0]:
                    if 'error' in m:
                        raise RuntimeError(m['error'])
                    return m.get('result', {})

        def js(expr):
            r = call('Runtime.evaluate', expression=expr, awaitPromise=True, returnByValue=True)
            if 'exceptionDetails' in r:
                return 'EXC: ' + r['exceptionDetails'].get('exception', {}).get('description', '')
            return r.get('result', {}).get('value')

        def wait(expr, t=30):
            t0 = time.time()
            while time.time() - t0 < t:
                try:
                    if js(f'!!({expr})') is True:
                        return True
                except Exception:
                    pass
                time.sleep(0.25)
            return False

        def nav(url, ready="document.documentElement.dataset.ready==='1'", t=30):
            call('Page.navigate', url=url)
            time.sleep(0.4)
            return wait(ready, t)

        call('Runtime.enable')
        call('Page.enable')

        check('サブディレクトリでライブラリが起動', nav(BASE))
        check('Service Worker が制御（スコープ /repo/）', wait('navigator.serviceWorker.controller', 40)
              and js("navigator.serviceWorker.getRegistration().then(r => r.scope)") == BASE)
        js("__lib.refreshCatalog({quiet:true}).then(() => 1)")
        n = js("__lib.S.catalog ? __lib.S.catalog.data.lectures.length : 0") or 0
        check('教材一覧を取得', n >= 1, f'{n} 件')
        js("__lib.download(__lib.S.catalog.data.lectures.map(e => e.id))")
        check('教材をすべてダウンロード', wait(f"document.querySelectorAll('.lib-row.st-ready').length === {n}", 120))
        v_app_a = js(STATUS + ".then(s => s.current)")
        print('  アプリの版 A =', v_app_a)
        first = js("__lib.S.catalog.data.lectures[0].path")

        # 実際にサーバを止める（機内モード相当）
        stop_server()
        check('サーバ停止中：ライブラリが起動', nav(BASE + 'index.html') and wait(f"document.querySelectorAll('.lib-row.st-ready').length === {n}"))
        ok = nav(BASE + f'lecture.html?l={first}')
        check('サーバ停止中：講義を開く', ok and js("!!document.querySelector('.lw-content')"))
        js(STROKE)
        check('サーバ停止中：書き込みを保存', js("__lw.view.page.state.strokes.length") == 1)
        has_pdf = [e for e in json.load(open(os.path.join(REPO, 'lectures', 'catalog.json'), encoding='utf-8'))['lectures']
                   if any(f['path'].endswith('.pdf') for f in e['files'])]
        if has_pdf:
            ok = nav(BASE + f"lecture.html?l={has_pdf[0]['path']}#1")
            check('サーバ停止中：PDF 教材を描画', ok and wait("(__lw.view.contents.get(__lw.view.page.id).pdfCanvas || {}).width > 0", 20))

        # アプリの新しい版を配信
        v_app_b = rebuild_sw_with_change()
        start_server()
        nav(BASE + 'index.html')
        js("navigator.serviceWorker.getRegistration().then(r => r.update()).then(() => 1, () => 0)")
        check('新しい版を検出（バナー表示）',
              wait("[...document.querySelectorAll('.lib-banner')].some(b => b.textContent.includes('アプリの新しい版'))", 40))
        st = js(STATUS)
        check('自動では切り替わらない（使用中は版 A）', isinstance(st, dict) and st.get('current') == v_app_a and st.get('updateAvailable'), json.dumps(st))
        nav(BASE + 'index.html')
        check('開き直しても版 A のファイル', 'build-B' not in (js("fetch('core/util.js').then(r => r.text())") or ''))
        call('Page.navigate', url='about:blank')        # 完全に閉じる → 新しい Service Worker が有効になる
        time.sleep(4)
        nav(BASE + 'index.html')
        wait("navigator.serviceWorker.controller", 20)
        st_c = js(STATUS)
        check('完全に閉じて起動し直しても版 A のまま（更新は押したときだけ）',
              isinstance(st_c, dict) and st_c.get('current') == v_app_a and st_c.get('updateAvailable')
              and 'build-B' not in (js("fetch('core/util.js').then(r => r.text())") or ''), json.dumps(st_c))
        js("import('./core/pwa.js').then(m => { m.applyAppUpdate(); return 1; })")
        time.sleep(4)
        wait("document.documentElement.dataset.ready==='1'", 30)
        st2 = js(STATUS)
        check('「アプリを更新」で版 B に切り替わる', isinstance(st2, dict) and st2.get('current') == v_app_b and not st2.get('updateAvailable'), json.dumps(st2))
        check('更新後は新しいファイル', 'build-B' in (js("fetch('core/util.js').then(r => r.text())") or ''))
        check('更新後も教材が残る', wait(f"document.querySelectorAll('.lib-row.st-ready').length === {n}", 20))
        ok = nav(BASE + f'lecture.html?l={first}')
        check('更新後も書き込みが残る', ok and js("__lw.view.page.state.strokes.length") == 1)
        stop_server()
        ok = nav(BASE + f'lecture.html?l={first}')
        check('更新後もサーバなしで起動', ok and js("__lw.view.page.state.strokes.length") == 1)

        # ---- 5. 非公開リポジトリの構成（アプリだけ公開、教材は GitHub API から） ----
        print('--- 非公開リポジトリの構成 ---')
        r = subprocess.run([sys.executable, os.path.join(PROJ, 'tools', 'build.py'), '--out', os.path.join(PRIV_SITE, 'app'),
                            '--app-only', '--content-out', PRIV_CONTENT], capture_output=True, text=True, encoding='utf-8')
        check('アプリ本体だけの公開フォルダと教材フォルダを作成', r.returncode == 0
              and not os.path.exists(os.path.join(PRIV_SITE, 'app', 'lectures'))
              and os.path.isfile(os.path.join(PRIV_CONTENT, 'catalog.json')), r.stdout[-300:] + r.stderr[-300:])
        app_srv = subprocess.Popen([sys.executable, '-c', STATIC_SERVER, PRIV_SITE, str(PRIV_PORT)])
        api_srv = subprocess.Popen([sys.executable, '-c', MOCK_GITHUB, PRIV_CONTENT, str(API_PORT), 'teacher/lectures', TOKEN, 'a' * 40])
        time.sleep(1)
        try:
            check('初回は配信元の設定を案内', nav(PRIV_BASE) and wait("document.querySelector('.lib-setup')", 15))
            wait('navigator.serviceWorker.controller', 40)
            set_src = lambda tok: js("import('./core/content/source.js').then(m => { m.setSource({ type: 'github', repo: 'teacher/lectures', branch: 'dist', token: '%s', api: 'http://localhost:%d' }); return 1; })" % (tok, API_PORT))
            set_src('wrong-token')
            js("__lib.refreshCatalog({quiet:true}).then(() => 1)")
            err = js("__lib.S.catalogError ? __lib.S.catalogError.message : ''") or ''
            check('トークンが違えば分かるように表示', 'トークン' in err, err)
            set_src(TOKEN)
            js("__lib.refreshCatalog({quiet:true}).then(() => 1)")
            n2 = js("__lib.S.catalog ? __lib.S.catalog.data.lectures.length : 0") or 0
            check('トークンで非公開の教材一覧を取得（別オリジン・CORS）', n2 >= 1 and js("__lib.S.catalog.ref") == 'a' * 40, f'{n2} 件')
            # 未ダウンロードの教材をタップ → ダウンロードしてから開く
            js("document.querySelector('.lib-row .lib-open').click(), 1")
            ok = wait("location.pathname.endsWith('lecture.html') && document.documentElement.dataset.ready==='1'", 60)
            check('未ダウンロードの教材をタップ → ダウンロードして開く', ok and js("__lw.lecture.base.includes('/offline/')"))
            check('JavaScript（widgets.js）も正しく読み込める', js("!__lw.lecture.widgets.__error"))
            paths = [e['path'] for e in json.load(open(os.path.join(PRIV_CONTENT, 'catalog.json'), encoding='utf-8'))['lectures']]
            opened = js("__lw.lecture.path")
            rest = [x for x in paths if x != opened]
            if rest:
                nav(PRIV_BASE + f'lecture.html?l={rest[0]}', ready="document.querySelector('.lw-fatal')", t=20)
                msg = js("(document.querySelector('.lw-fatal') || {}).textContent || ''") or ''
                check('未ダウンロードの教材は直接開けない（案内を表示）', 'ダウンロード' in msg, msg[:80])
            nav(PRIV_BASE + 'index.html')
            js("__lib.download(__lib.S.catalog.data.lectures.map(e => e.id))")
            check('非公開の教材をすべてダウンロード', wait(f"document.querySelectorAll('.lib-row.st-ready').length === {n2}", 90))
            bk = js("Promise.all([import('./core/store.js'), import('./core/library/backup.js')]).then(([s, b]) => s.openStore().then(st => b.createBackup(st, { materials: false }))).then(blob => blob.text())") or ''
            check('バックアップにトークンを含めない', TOKEN not in bk and 'teacher/lectures' in bk)
        finally:
            for pr in (app_srv, api_srv):
                pr.terminate()
                try:
                    pr.wait(5)
                except Exception:
                    pr.kill()
        ok = nav(PRIV_BASE + f'lecture.html?l={paths[0]}')
        check('サーバ・API 停止中も非公開の教材を開ける', ok and js("!!document.querySelector('.lw-content')"))
        ws.close()
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except Exception:
            proc.kill()
        try:
            stop_server()
        except Exception:
            pass
        time.sleep(0.5)
        shutil.rmtree(WORK, ignore_errors=True)
    n_fail = sum(1 for _, ok in results if not ok)
    print(f'{"ALL PASSED" if not n_fail else "FAILED"} {len(results) - n_fail}/{len(results)}')
    sys.exit(1 if n_fail else 0)


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except (AttributeError, ValueError):
        pass
    main()
