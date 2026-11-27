#!/usr/bin/env python3
"""
演習（Julia）の総合テスト：開発用サーバ（tools/serve.py）＋ Lectoryx ローカル実行ツール（runner/）＋ Chrome

    pip install playwright        （Chrome を使う。WebKit も試すなら python -m playwright install webkit）
    python tests/e2e_exercise.py [--home DIR]

PC に Julia が必要。確かめること：
  ・実行ツールの zip（開発サーバの設定入り）、ライブラリでのペアリング（# 以降を保存して消す）
  ・講義の演習のカード → シート → PC の Julia に接続 → 実行・停止（無限ループ）・採点（正解・誤答）・カードの表示と保存
  ・教材の環境（_julia/linalg。warmup.jl を含めて実行ツールに渡す）
  ・本物のクリップボードでの貼り付けの制限、iPad（閲覧のみ）、許可していない Origin、合言葉の誤り
  ・tools/exercise.py の一括実行（期待値が最新か）と tools/build.py の検証（期待値が古いとエラー）
"""
import argparse
import io
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
PORT = 8131
RPORT = 27199
LEC = '_test_exercise'
RESULTS = []


def check(name, ok, detail=''):
    RESULTS.append(bool(ok))
    print(f"{'✓' if ok else '✗'} {name}{('  ' + str(detail)) if detail else ''}", flush=True)


def wait_port(p, n=600):
    for _ in range(n):
        try:
            socket.create_connection(('127.0.0.1', p), 0.2).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def julia_exe():
    j = shutil.which('julia')
    if not j:
        raise SystemExit('Julia が見つかりません')
    r = subprocess.run([j, '--startup-file=no', '-e', 'print(joinpath(Sys.BINDIR, Base.julia_exename()))'], capture_output=True, text=True)
    return r.stdout.strip() or j


def open_lecture(page, hash_='#1'):
    page.goto(f'http://localhost:{PORT}/lecture.html?l={LEC}{hash_}')
    page.wait_for_function("() => document.documentElement.dataset.ready === '1'", timeout=30000)


def open_card(page, n=0):
    page.locator('.lw-exercise .lw-ex-card-open').nth(n).click()
    page.wait_for_selector('.lw-ex-sheet')


def wait_engine(page, text, timeout=30000):
    page.wait_for_function(f"() => document.querySelector('.lw-ex-engine')?.textContent.includes({text!r})", timeout=timeout)


def run_code(page, code, timeout=60000):
    page.fill('.lw-ex-code', code)
    page.click('.lw-ex-sheet button:has-text("実行")')
    page.wait_for_function("() => { const s = document.querySelector('.lw-ex-panel-head .lw-ex-muted').textContent; return s.includes('秒') || s.includes('止め'); }", timeout=timeout)
    return page.inner_text('.lw-ex-output')


def grade(page, code, timeout=120000):
    page.fill('.lw-ex-code', code)
    page.click('.lw-ex-sheet button:has-text("採点")')
    page.wait_for_function("() => /\\d+ \\/ \\d+|できません/.test(document.querySelector('.lw-ex-score').textContent)", timeout=timeout)
    return page.inner_text('.lw-ex-score').strip()


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser()
    ap.add_argument('--home', help='実行ツールの作業フォルダ（既定は一時フォルダ）')
    a = ap.parse_args()
    from playwright.sync_api import sync_playwright

    home = Path(a.home) if a.home else Path(tempfile.mkdtemp(prefix='lectoryx-home-'))
    jl = julia_exe()
    # ---- 期待値づくりのツールと検証 ----
    r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'exercise.py'), str(ROOT / 'lectures' / LEC), '--home', str(home)],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    check('tools/exercise.py：テスト用の演習の期待値は最新', r.returncode == 0 and r.stdout.count('最新') == 2, r.stdout.strip()[-200:])
    md = ROOT / 'lectures' / 'demo' / 'julia-exercise' / 'exercises' / 'newton-step.md'
    orig = md.read_bytes()
    try:
        md.write_bytes(orig + b'\n')
        r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'build.py'), '--check'], capture_output=True, text=True, encoding='utf-8', errors='replace')
        check('tools/build.py：演習を直して期待値を作り直していなければエラー（配信しない）', r.returncode == 1 and '期待値が古い' in r.stdout)
    finally:
        md.write_bytes(orig)
    r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'build.py'), '--check'], capture_output=True, text=True, encoding='utf-8', errors='replace')
    check('tools/build.py：元に戻せばエラーなし', r.returncode == 0, r.stdout.strip().splitlines()[-1:])

    srv = subprocess.Popen([sys.executable, str(ROOT / 'tools' / 'serve.py'), str(PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    runner = subprocess.Popen([jl, '--startup-file=no', str(ROOT / 'runner' / 'lectoryx-runner.jl'), '--port', str(RPORT), '--home', str(home),
                               '--app', f'http://localhost:{PORT}/', '--allow-origin', f'http://localhost:{PORT}'],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8')
    log = []
    threading.Thread(target=lambda: [log.append(x) for x in runner.stdout], daemon=True).start()
    try:
        if not (wait_port(PORT) and wait_port(RPORT)):
            check('サーバと実行ツールが起動する', False)
            return 1
        token = (home / 'token').read_text().strip()
        z = zipfile.ZipFile(io.BytesIO(urlopen(f'http://localhost:{PORT}/runner/lectoryx-runner.zip').read()))
        cfg = z.read('lectoryx-runner/lectoryx-runner.toml').decode('utf-8')
        check('実行ツールの zip（開発サーバの設定入り）', 'lectoryx-runner/lectoryx-runner.jl' in z.namelist() and f'http://localhost:{PORT}' in cfg)

        with sync_playwright() as p:
            b = p.chromium.launch(channel='chrome')
            ctx = b.new_context(viewport={'width': 1180, 'height': 820}, permissions=['clipboard-read', 'clipboard-write'])
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))

            # ---- ペアリング（ライブラリ） ----
            page.goto(f'http://localhost:{PORT}/#lectoryx={RPORT}.{token}')
            page.wait_for_function("() => !!localStorage.getItem('lectoryx.runner')", timeout=15000)
            page.wait_for_timeout(600)
            toast = page.inner_text('.lw-toast') if page.query_selector('.lw-toast') else ''
            check('ライブラリでペアリング（保存してアドレスバーから消す・通知）', 'lectoryx=' not in page.url and 'つなぎました' in toast)

            # ---- 実行・停止・採点 ----
            open_lecture(page)
            page.evaluate("async () => { await window.__lw.store.clearLecture('_test_exercise'); }")
            open_lecture(page)
            open_card(page, 0)
            t0 = time.time()
            wait_engine(page, 'PC の Julia 1')
            check('シートを開くと PC の Julia に接続', True, f'{time.time() - t0:.1f} 秒')
            out = run_code(page, 'f(x) = 2x\nprintln("答え: ", f(21))\nf(1.5)\n')
            check('実行：出力と最後の値', '答え: 42' in out and '→ 3.0' in out, out.strip()[:60])
            out = run_code(page, 'x = [1, 2\n')
            check('実行：構文エラーを表示', page.query_selector('.lw-ex-output .lw-ex-err') is not None, out.strip()[:60])
            page.fill('.lw-ex-code', 'println("開始")\nwhile true\nend\n')
            page.click('.lw-ex-sheet button:has-text("実行")')
            page.wait_for_function("() => document.querySelector('.lw-ex-output').textContent.includes('開始')", timeout=30000)
            t1 = time.time()
            page.click('.lw-ex-sheet button:has-text("停止")')
            page.wait_for_function("() => !document.querySelector('.lw-ex-sheet button.lw-ex-primary').disabled", timeout=20000)
            check('停止ボタンで無限ループを止める', time.time() - t1 < 3 and '止め' in page.inner_text('.lw-ex-sheet'), f'{time.time() - t1:.2f} 秒')
            check('採点：誤答は一部だけ合格', grade(page, 'f(x) = x^2\n') == '0 / 2')
            check('採点：正解はすべて合格', grade(page, 'f(x) = 2x\n') == '2 / 2')
            page.keyboard.press('Escape')
            card = page.locator('.lw-exercise').nth(0).inner_text()
            check('カードに採点の結果を表示', '合格（2 / 2）' in card, card.replace('\n', ' / '))

            # ---- 教材の環境（warmup を含めて渡す） ----
            open_card(page, 2)
            wait_engine(page, 'PC の Julia 1')
            t2 = time.time()
            res = grade(page, 'using LinearAlgebra\nev(A) = sort(eigvals(A))\n', timeout=300000)
            check('教材の環境（_julia/linalg）を用意して採点', res == '2 / 2', f'{res}（{time.time() - t2:.1f} 秒）')
            envs = [d.name for d in (home / 'envs').iterdir()] if (home / 'envs').is_dir() else []
            warm = [d for d in envs if d.startswith('linalg-') and (home / 'envs' / d / 'src' / 'LectoryxEnv.jl').is_file()]
            check('warmup.jl を事前コンパイルの環境にした', bool(warm), envs)
            page.keyboard.press('Escape')

            # ---- 本物のクリップボードでの貼り付け ----
            open_card(page, 0)
            page.evaluate("() => navigator.clipboard.writeText('f(x) = 2x')")
            page.fill('.lw-ex-code', '')
            page.focus('.lw-ex-code')
            page.keyboard.press('ControlOrMeta+V')
            page.wait_for_timeout(200)
            check('ほかの場所からの Ctrl+V は入らない（既定）', page.input_value('.lw-ex-code') == '' and page.is_visible('.lw-ex-pastenote'))
            page.keyboard.press('Escape')
            page.evaluate("() => window.__lw.view.show(1)")
            open_card(page, 0)
            page.evaluate("() => navigator.clipboard.writeText('f(x) = 2x')")
            page.fill('.lw-ex-code', '')
            page.focus('.lw-ex-code')
            page.keyboard.press('ControlOrMeta+V')
            page.wait_for_timeout(200)
            check('paste=on の演習は Ctrl+V で貼り付けられる', page.input_value('.lw-ex-code') == 'f(x) = 2x')
            page.keyboard.press('Escape')
            page.wait_for_timeout(1000)
            open_lecture(page)
            card = page.locator('.lw-exercise').nth(0).inner_text()
            check('再読み込みしても採点の結果が残る', '合格（2 / 2）' in card)
            check('ページのエラーなし', not errors, '; '.join(errors)[:200])
            ctx.close()

            # ---- iPad（閲覧のみ） ----
            ipad = b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True,
                                 user_agent='Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
            pg = ipad.new_page()
            open_lecture(pg)
            open_card(pg, 0)
            pg.wait_for_timeout(500)
            check('iPad では閲覧のみ（接続しない・実行できない）', 'この端末では実行できません' in pg.inner_text('.lw-ex-engine') and pg.is_disabled('.lw-ex-sheet button.lw-ex-primary'))
            ipad.close()

            # ---- 許可していない Origin・合言葉の誤り ----
            other = b.new_context()
            pg = other.new_page()
            pg.goto(f'http://127.0.0.1:{PORT}/#lectoryx={RPORT}.{token}')
            pg.wait_for_function("() => !!localStorage.getItem('lectoryx.runner')", timeout=15000)
            pg.goto(f'http://127.0.0.1:{PORT}/lecture.html?l={LEC}#1')
            pg.wait_for_function("() => document.documentElement.dataset.ready === '1'", timeout=30000)
            open_card(pg, 0)
            wait_engine(pg, '見つかりません')
            check('許可していないページ（Origin）からは接続できない', True)
            other.close()
            bad = b.new_context()
            pg = bad.new_page()
            pg.goto(f'http://localhost:{PORT}/#lectoryx={RPORT}.{"0" * 48}')
            pg.wait_for_function("() => !!localStorage.getItem('lectoryx.runner')", timeout=15000)
            open_lecture(pg)
            open_card(pg, 0)
            wait_engine(pg, '合言葉が違います')
            check('合言葉が違えば接続できない', True)
            bad.close()
            b.close()
    finally:
        runner.terminate()
        srv.terminate()
        try:
            runner.wait(timeout=20)
        except subprocess.TimeoutExpired:
            runner.kill()
        if not a.home:
            shutil.rmtree(home, ignore_errors=True)
    n = sum(RESULTS)
    print(f'{n}/{len(RESULTS)} 合格')
    return 0 if n == len(RESULTS) else 1


if __name__ == '__main__':
    sys.exit(main())
