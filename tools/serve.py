#!/usr/bin/env python3
"""
Lectoryx の開発用 HTTP サーバ（標準ライブラリのみ）

    python tools/serve.py            # ポート 8000
    python tools/serve.py 8080       # ポート指定

・プロジェクトのルートを配信し、同じネットワーク上の iPad から開く URL を表示する
・Cache-Control: no-cache を付けるので、教材を編集したら iPad 側で再読み込みするだけで反映される
・教材一覧 lectures/catalog.json と sw.js（アプリのファイル一覧入り）はリクエストのたびに生成する
  （開発用。Service Worker はネットワーク優先で動くので、編集はすぐ反映される）
・courses/（実際の授業の教材。別の非公開リポジトリ）があれば、lectures/（公開のデモ）と合わせて
  /lectures/ の下に見せる。授業の教材もアプリから直接確認できる（同じパスなら courses/ が優先）
・オフライン機能（Service Worker）は https か localhost でだけ動く。
  LAN の http://192.168.… で iPad から開いた場合は、オンライン専用の確認になる。
"""
import http.server
import json
import os
import posixpath
import socket
import socketserver
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build  # noqa: E402  （同じフォルダの build.py）

_last_report = [None]
COURSES_DIR = os.path.join(ROOT, build.COURSES)


def dev_catalog():
    """lectures/（デモ）と courses/（授業の教材）を合わせた教材一覧"""
    cat, reports = build.build_catalog()
    if os.path.isdir(COURSES_DIR):
        c2, r2 = build.build_catalog(content_root=COURSES_DIR)
        have = {e['path'] for e in c2['lectures']}
        c2['lectures'] += [e for e in cat['lectures'] if e['path'] not in have]
        c2['courses'] = c2['courses'] + [c for c in cat['courses'] if c not in c2['courses']]
        cat, reports = c2, r2 + reports
    return build.public_catalog(cat), reports


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.md': 'text/markdown; charset=utf-8',
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
        '.woff2': 'font/woff2',
        '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def translate_path(self, path):
        """/lectures/… は courses/ にあればそちらを返す"""
        prefix = f'/{build.CONTENT}/'
        p = path.split('?', 1)[0].split('#', 1)[0]
        if p.startswith(prefix) and os.path.isdir(COURSES_DIR):
            rel = posixpath.normpath(urllib.parse.unquote(p[len(prefix):]))
            if rel and not rel.startswith('..') and not rel.startswith('/'):
                alt = os.path.join(COURSES_DIR, *rel.split('/'))
                if os.path.exists(alt):
                    return alt
        return super().translate_path(path)

    def send_bytes(self, body: bytes, ctype: str):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        try:
            if path == '/' + build.SW_FILE:
                return self.send_bytes(build.render_sw(dev=True).encode('utf-8'), 'text/javascript; charset=utf-8')
            if path == f'/{build.CONTENT}/{build.CATALOG}':
                catalog, reports = dev_catalog()
                summary = [(r['entry']['path'], r['errors'], r['warnings']) for r in reports]
                if summary != _last_report[0]:
                    _last_report[0] = summary
                    build.print_report(reports, verbose=False)
                return self.send_bytes(json.dumps(catalog, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8')
        except Exception as e:  # 生成に失敗してもサーバは止めない
            sys.stderr.write(f'[error] {path}: {e}\n')
            self.send_error(500, str(e))
            return None
        return super().do_GET()

    def do_HEAD(self):
        path = self.path.split('?', 1)[0]
        if path in ('/' + build.SW_FILE, f'/{build.CONTENT}/{build.CATALOG}'):
            return self.do_GET()
        return super().do_HEAD()

    def log_message(self, fmt, *args):
        if '404' in (fmt % args):
            sys.stderr.write('[404] %s\n' % self.path)


def lan_addresses():
    addrs = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        addrs.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in addrs if not a.startswith('127.'))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except (AttributeError, ValueError):
        pass
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    with Server(('0.0.0.0', port), Handler) as httpd:
        print('講義フレームワーク サーバを起動しました（Ctrl+C で終了）')
        print(f'  この PC  : http://localhost:{port}/')
        for a in lan_addresses():
            print(f'  iPad から: http://{a}:{port}/')
        print('※ iPad と PC を同じ Wi-Fi に接続してください。つながらない場合はファイアウォールの許可を確認。')
        print('※ オフライン機能（ダウンロード・ホーム画面アプリ）は https（GitHub Pages）か localhost でだけ動きます。')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n終了しました')


if __name__ == '__main__':
    main()
