#!/usr/bin/env python3
"""
演習（Julia）の期待値づくりと点検：<講義>/exercises/<id>.md → <講義>/exercises/<id>.json（配信するのはこちら）

    python tools/exercise.py                          lectures/ の演習すべて（期待値が古いものだけ作り直す）
    python tools/exercise.py --content-dir courses    courses/ の演習
    python tools/exercise.py courses/control/03-pid   講義フォルダ（または演習ファイル）を指定
      --force       最新のものも作り直す
      --julia PATH  使う Julia（既定は PATH の julia）
      --home DIR    実行ツールの作業フォルダ（既定 ~/.lectoryx。教材の環境のパッケージをここに用意する）

PC にインストールした公式 Julia で、Lectoryx ローカル実行ツール（runner/lectoryx-runner.jl --batch）を使い、
学生の実行・採点と同じ方法で次を確かめる（Python 標準ライブラリのみ）。
  ・模範解答（```julia solution）：すべてのテストに合格する。期待値はここから作る
  ・別解（```julia alt）：すべてのテストに合格する（学生が書きそうな正しい解き方）
  ・誤答（```julia wrong）：少なくとも 1 件のテストで不合格になる（テストが甘くないか）
通った演習だけ exercises/<id>.json を書く。JSON には模範解答・別解・誤答を入れない（問題文・ひな形・テスト・期待値だけ）。
JSON の source は演習ファイルと教材の環境のハッシュ。tools/build.py は、これが今のファイルと合わなければエラーにする
（演習を直したら、このツールを実行し直してから push する）。

演習ファイルの書式は CLAUDE.md「4.9 演習（Julia）」を参照。
"""
import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / 'runner' / 'lectoryx-runner.jl'
FORMAT = 'lectoryx-exercise'
VERSION = 1
ID_RE = re.compile(r'^[A-Za-z0-9_-]+$')
FENCE = re.compile(r'^```julia[ \t]+(template|solution|test|wrong|alt)\b(.*)$')
ATTR = re.compile(r'(\w+)(?:=("([^"]*)"|\S+))?')
KINDS = ('value', 'assert', 'output', 'error')


class ExerciseError(Exception):
    pass


# ---------------------------------------------------------------
# 演習ファイルの読み取り
# ---------------------------------------------------------------
def read_text(p: Path) -> str:
    return p.read_text(encoding='utf-8').replace('\r\n', '\n').lstrip('﻿')


def parse_attrs(s):
    d = {}
    for m in ATTR.finditer(s):
        k, raw, q = m.group(1), m.group(2), m.group(3)
        d[k] = q if q is not None else (raw if raw is not None else True)
    return d


def parse_exercise(path: Path):
    text = read_text(path)
    meta = {}
    if text.startswith('---\n'):
        end = text.find('\n---\n', 4)
        if end < 0:
            raise ExerciseError('先頭の --- が閉じていません')
        for line in text[4:end].split('\n'):
            if ':' in line and not line.lstrip().startswith('#'):
                k, v = line.split(':', 1)
                meta[k.strip()] = v.strip().strip('"\'')
        text = text[end + 5:]
    prompt, blocks, cur = [], [], None
    for n, line in enumerate(text.split('\n'), 1):
        if cur is None:
            m = FENCE.match(line)
            if m:
                cur = {'role': m.group(1), 'attrs': parse_attrs(m.group(2)), 'lines': []}
            else:
                prompt.append(line)
        elif line.strip() == '```':
            cur['code'] = '\n'.join(cur.pop('lines')) + '\n'
            blocks.append(cur)
            cur = None
        else:
            cur['lines'].append(line)
    if cur is not None:
        raise ExerciseError('```julia のコードブロックが閉じていません')
    get = lambda role: [b for b in blocks if b['role'] == role]
    if len(get('solution')) != 1 or len(get('template')) != 1:
        raise ExerciseError('```julia template と ```julia solution を 1 つずつ書いてください')
    eid = meta.get('id') or path.stem
    if not ID_RE.match(eid):
        raise ExerciseError(f'id "{eid}" に使えない文字があります（英数字と - _）')
    if eid != path.stem:
        raise ExerciseError(f'id: {eid} とファイル名（{path.stem}.md）を同じにしてください')
    if not get('test'):
        raise ExerciseError('```julia test が 1 つもありません')
    tests = []
    for i, b in enumerate(get('test'), 1):
        a = b['attrs']
        t = {'name': str(a.get('name', f'テスト {i}')), 'kind': str(a.get('kind', 'value')), 'code': b['code']}
        if t['kind'] not in KINDS:
            raise ExerciseError(f"テスト「{t['name']}」：kind={t['kind']} は使えません（{', '.join(KINDS)}）")
        for k in ('rtol', 'atol'):
            if k in a:
                try:
                    t[k] = float(a[k])
                except ValueError:
                    raise ExerciseError(f"テスト「{t['name']}」：{k}={a[k]} は数値ではありません")
        if a.get('type'):
            t['checkType'] = True
        if a.get('hidden'):
            t['hidden'] = True
        tests.append(t)
    try:
        limit = float(meta.get('timeLimit', 5))
    except ValueError:
        raise ExerciseError(f"timeLimit: {meta.get('timeLimit')} は秒数で書いてください")
    return {
        'id': eid, 'title': meta.get('title') or eid, 'timeLimitMs': int(limit * 1000), 'envName': meta.get('env') or None,
        'prompt': '\n'.join(prompt).strip() + '\n', 'template': get('template')[0]['code'], 'tests': tests,
        'solution': get('solution')[0]['code'],
        'wrong': [{'name': str(b['attrs'].get('name', f'誤答 {i}')), 'code': b['code']} for i, b in enumerate(get('wrong'), 1)],
        'alt': [{'name': str(b['attrs'].get('name', f'別解 {i}')), 'code': b['code']} for i, b in enumerate(get('alt'), 1)],
    }


def find_env(md: Path, name: str, content_root: Path):
    """教材の環境 <フォルダ>/_julia/<name>/（演習のある講義フォルダから教材ルートまで上にたどる）"""
    if not ID_RE.match(name):
        raise ExerciseError(f'env: {name} に使えない文字があります')
    d = md.parent.parent.resolve()
    top = content_root.resolve()
    while True:
        cand = d / '_julia' / name
        if (cand / 'Project.toml').is_file():
            return cand
        if d == top or d.parent == d:
            break
        d = d.parent
    raise ExerciseError(f'env: {name} の環境（_julia/{name}/Project.toml）が見つかりません')


def env_spec(env_dir: Path, name: str):
    get = lambda f: read_text(env_dir / f) if (env_dir / f).is_file() else ''
    return {'name': name, 'project': get('Project.toml'), 'manifest': get('Manifest.toml'), 'warmup': get('warmup.jl')}


def source_hash(md: Path, content_root: Path) -> str:
    """演習ファイルと教材の環境のハッシュ（JSON の source。tools/build.py が古さの確認に使う）"""
    text = read_text(md)
    m = re.match(r'---\n(.*?)\n---\n', text, re.S)
    env = None
    if m:
        for line in m.group(1).split('\n'):
            if line.strip().startswith('env:'):
                env = line.split(':', 1)[1].strip().strip('"\'') or None
    parts = [f'{FORMAT}-{VERSION}', text]
    if env:
        s = env_spec(find_env(md, env, content_root), env)
        parts += [s['project'], s['manifest'], s['warmup']]
    return hashlib.sha256('\0'.join(parts).encode('utf-8')).hexdigest()[:20]


# ---------------------------------------------------------------
# 判定（core/exercise/grader.js・value.js と同じ規則）
# ---------------------------------------------------------------
def _num(v):
    if isinstance(v, (int, float)):
        return float(v)
    return {'NaN': math.nan, 'Inf': math.inf, '-Inf': -math.inf}.get(v, None) if isinstance(v, str) else None


def _close(a, b, rtol, atol):
    if isinstance(a, str) and isinstance(b, str) and _num(a) is None and _num(b) is None:
        return a == b                                  # 大きな整数は文字列で厳密に
    x, y = _num(a), _num(b)
    if x is None or y is None:
        return str(a) == str(b)
    if math.isnan(x) or math.isnan(y):
        return math.isnan(x) and math.isnan(y)
    if math.isinf(x) or math.isinf(y):
        return x == y
    return abs(x - y) <= atol + rtol * max(abs(x), abs(y))


def _norm_type(jt):
    if not jt:
        return ''
    s = re.sub(r'^Array\{(.+),\s*1\}$', r'Vector{\1}', str(jt))
    s = re.sub(r'^Array\{(.+),\s*2\}$', r'Matrix{\1}', s)
    return re.sub(r',\s+', ',', s.replace('Complex{Float64}', 'ComplexF64'))


def compare_values(a, e, rtol=1e-8, atol=1e-10, check_type=False):
    """一致すれば None、違えば理由"""
    if a is None or e is None:
        return '値がありません'
    if a.get('t') == 'num' and e.get('t') == 'complex' and _close(e.get('im'), 0, 0, atol):
        a = {'t': 'complex', 're': a.get('v'), 'im': 0}
    if a.get('t') == 'complex' and e.get('t') == 'num' and _close(a.get('im'), 0, 0, atol):
        e = {'t': 'complex', 're': e.get('v'), 'im': 0}
    if a.get('t') != e.get('t'):
        return f"種類が違います（期待 {e.get('t')}、結果 {a.get('t')}）"
    if check_type and e.get('jt') and a.get('jt') and _norm_type(e['jt']) != _norm_type(a['jt']) and a['t'] != 'tuple':
        return f"型が違います（期待 {e['jt']}、結果 {a['jt']}）"
    t = e['t']
    if t == 'num':
        return None if _close(a.get('v'), e.get('v'), rtol, atol) else f"値が違います（期待 {e.get('v')}、結果 {a.get('v')}）"
    if t == 'complex':
        dr = (_num(a['re']) or 0) - (_num(e['re']) or 0)
        di = (_num(a['im']) or 0) - (_num(e['im']) or 0)
        na, nb = math.hypot(_num(a['re']) or 0, _num(a['im']) or 0), math.hypot(_num(e['re']) or 0, _num(e['im']) or 0)
        return None if math.hypot(dr, di) <= atol + rtol * max(na, nb) else '値が違います（複素数）'
    if t in ('bool', 'str'):
        return None if a.get('v') == e.get('v') else f"値が違います（期待 {e.get('v')!r}、結果 {a.get('v')!r}）"
    if t == 'nothing':
        return None
    if t == 'array':
        if a.get('shape') != e.get('shape'):
            return f"形が違います（期待 {e.get('shape')}、結果 {a.get('shape')}）"
        for i, (x, y) in enumerate(zip(a.get('data', []), e.get('data', []))):
            r = compare_values(x, y, rtol, atol, check_type)
            if r:
                return f'{i + 1} 番目の要素：{r}'
        return None
    if t == 'tuple':
        if len(a.get('items', [])) != len(e.get('items', [])):
            return '要素の数が違います'
        for i, (x, y) in enumerate(zip(a['items'], e['items'])):
            r = compare_values(x, y, rtol, atol, check_type)
            if r:
                return f'{i + 1} 番目：{r}'
        return None
    return None if (a.get('display') or '') == (e.get('display') or '') else '値が違います'


def _norm_out(s):
    return re.sub(r'\n+$', '', re.sub(r'[ \t]+$', '', str(s or '').replace('\r\n', '\n'), flags=re.M))


def judge(test, r):
    """(合格か, 理由)"""
    if r is None:
        return False, '実行されませんでした'
    if test['kind'] == 'error':
        if r.get('timedOut'):
            return False, '制限時間を超えました'
        return (not r.get('ok')), ('' if not r.get('ok') else 'エラーになりませんでした')
    if r.get('timedOut'):
        return False, '制限時間を超えました'
    if not r.get('ok'):
        return False, 'エラー: ' + str((r.get('error') or {}).get('message', '')).split('\n')[0][:120]
    if test['kind'] == 'output':
        ok = _norm_out(r.get('output')) == _norm_out(test.get('expectedOutput'))
        return ok, '' if ok else '表示が違います'
    v = r.get('value')
    if test['kind'] == 'assert':
        ok = v == {'t': 'bool', 'v': True}
        return ok, '' if ok else f'true になりません（{v}）'
    why = compare_values(v, test.get('expected'), test.get('rtol', 1e-8), test.get('atol', 1e-10), test.get('checkType', False))
    return why is None, why or ''


def grade(ex, res):
    """実行結果 → [(テスト名, 合格か, 理由)]、学生のコードが動かなければ base のエラー"""
    if not res or 'error' in res:
        return None, (res or {}).get('error', '実行できません')
    base = res.get('base') or {}
    if not base.get('ok'):
        reason = '制限時間を超えました' if base.get('timedOut') else str((base.get('error') or {}).get('message', 'エラー')).split('\n')[0][:160]
        return None, reason
    return [(t['name'], *judge(t, r)) for t, r in zip(ex['tests'], res.get('tests') or [])], None


# ---------------------------------------------------------------
# 実行（runner/lectoryx-runner.jl --batch）
# ---------------------------------------------------------------
def find_julia(given):
    j = given or shutil.which('julia')
    if not j:
        raise SystemExit('Julia が見つかりません（https://julialang.org/install/ からインストールするか、--julia で指定してください）')
    # juliaup のランチャーではなく、本体の julia を直接使う（環境変数の受け渡しを確実にするため）
    try:
        r = subprocess.run([j, '--startup-file=no', '-e', 'print(joinpath(Sys.BINDIR, Base.julia_exename()))'],
                           capture_output=True, text=True, timeout=120)
        if r.returncode == 0 and Path(r.stdout.strip()).is_file():
            return r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return j


def run_batch(julia, home, envs, jobs):
    with tempfile.TemporaryDirectory(prefix='lectoryx-ex-') as tmp:
        fin, fout = Path(tmp) / 'in.json', Path(tmp) / 'out.json'
        fin.write_text(json.dumps({'envs': envs, 'jobs': jobs}, ensure_ascii=False), encoding='utf-8')
        cmd = [julia, '--startup-file=no', str(RUNNER), '--batch', str(fin), str(fout)]
        if home:
            cmd += ['--home', str(home)]
        r = subprocess.run(cmd)
        if r.returncode != 0 or not fout.is_file():
            raise SystemExit('実行ツールが途中で止まりました（上の表示を確認してください）')
        return json.loads(fout.read_text(encoding='utf-8'))


# ---------------------------------------------------------------
# 本体
# ---------------------------------------------------------------
def collect(targets, content_root: Path):
    files = []
    for t in targets or [content_root]:
        p = Path(t).resolve()
        if p.is_file() and p.suffix == '.md':
            files.append(p)
        elif p.is_dir():
            files += [f for f in sorted(p.rglob('exercises/*.md')) if not any(x.startswith('.') for x in f.relative_to(p).parts)]
        else:
            raise SystemExit(f'{t} が見つかりません')
    return sorted(set(files))


def public_json(ex, spec, src_hash, info):
    out = {
        'format': FORMAT, 'version': VERSION,
        'id': ex['id'], 'title': ex['title'], 'prompt': ex['prompt'], 'template': ex['template'],
        'timeLimitMs': ex['timeLimitMs'], 'env': spec, 'tests': ex['tests'],
        'source': src_hash, 'generatedBy': info,
    }
    return json.dumps(out, ensure_ascii=False, indent=1) + '\n'


def main():
    ap = argparse.ArgumentParser(description='演習（Julia）の期待値づくりと点検')
    ap.add_argument('targets', nargs='*', help='講義フォルダ・演習ファイル（省略時は教材ルート全体）')
    ap.add_argument('--content-dir', help='教材ルート（既定 lectures/）')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--julia')
    ap.add_argument('--home')
    a = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except (AttributeError, ValueError):
        pass
    content_root = Path(a.content_dir).resolve() if a.content_dir else ROOT / 'lectures'
    files = collect(a.targets, content_root)
    if not files:
        print('演習ファイル（<講義>/exercises/*.md）がありません')
        return 0

    todo, failed = [], 0
    for md in files:
        name = md.relative_to(content_root).as_posix() if md.is_relative_to(content_root) else str(md)
        try:
            ex = parse_exercise(md)
            spec = env_spec(find_env(md, ex['envName'], content_root), ex['envName']) if ex['envName'] else None
            h = source_hash(md, content_root)
        except ExerciseError as e:
            print(f'✗ {name}: {e}')
            failed += 1
            continue
        out = md.with_suffix('.json')
        if not a.force and out.is_file():
            try:
                if json.loads(out.read_text(encoding='utf-8')).get('source') == h:
                    print(f'  {name}: 最新')
                    continue
            except (ValueError, OSError):
                pass
        todo.append({'md': md, 'name': name, 'ex': ex, 'spec': spec, 'hash': h, 'out': out})
    if not todo:
        print('作り直す演習はありません' + ('' if not failed else f'（エラー {failed} 件）'))
        return 1 if failed else 0

    envs, jobs = {}, []
    for k, t in enumerate(todo):
        ex = t['ex']
        if t['spec']:
            if t['spec']['name'] in envs and envs[t['spec']['name']] != t['spec']:
                print(f"✗ {t['name']}: 同じ名前の環境 {t['spec']['name']} が別の内容で使われています")
                failed += 1
                continue
            envs[t['spec']['name']] = t['spec']
        tests = [{'code': x['code']} for x in ex['tests']]
        env = t['spec']['name'] if t['spec'] else None
        limit = ex['timeLimitMs']
        jobs.append({'id': f'{k}:sol', 'env': env, 'code': ex['solution'], 'tests': tests, 'timeoutMs': max(limit, 30000)})
        for i, x in enumerate(ex['alt']):
            jobs.append({'id': f'{k}:alt:{i}', 'env': env, 'code': x['code'], 'tests': tests, 'timeoutMs': limit})
        for i, x in enumerate(ex['wrong']):
            jobs.append({'id': f'{k}:wrong:{i}', 'env': env, 'code': x['code'], 'tests': tests, 'timeoutMs': limit})
    print(f'公式 Julia で {len(todo)} 件の演習を確かめます（実行 {len(jobs)} 回）')
    julia = find_julia(a.julia)
    res = run_batch(julia, a.home, envs, jobs)
    info = f"Julia {res.get('julia')}（Lectoryx ローカル実行ツール {res.get('runner')}）"
    R = res.get('results', {})

    for k, t in enumerate(todo):
        ex = t['ex']
        problems = []
        sol = R.get(f'{k}:sol')
        if not sol or 'error' in sol:
            problems.append(f"実行できません: {(sol or {}).get('error', '結果がありません')}")
        elif not (sol.get('base') or {}).get('ok'):
            problems.append('模範解答がエラーになります: ' + str(((sol.get('base') or {}).get('error') or {}).get('message', '')).split('\n')[0][:200])
        else:
            for test, r in zip(ex['tests'], sol.get('tests') or []):
                kind = test['kind']
                if r is None:
                    problems.append(f"テスト「{test['name']}」の結果がありません")
                elif kind == 'error':
                    if r.get('ok') or r.get('timedOut'):
                        problems.append(f"テスト「{test['name']}」：模範解答でエラーになりません")
                elif not r.get('ok'):
                    why = '制限時間を超えました' if r.get('timedOut') else str((r.get('error') or {}).get('message', '')).split('\n')[0][:200]
                    problems.append(f"テスト「{test['name']}」：模範解答でエラー: {why}")
                elif kind == 'value':
                    test['expected'] = r.get('value')
                elif kind == 'output':
                    test['expectedOutput'] = r.get('output', '')
                elif kind == 'assert' and r.get('value') != {'t': 'bool', 'v': True}:
                    problems.append(f"テスト「{test['name']}」：模範解答で true になりません（{r.get('value')}）")
                if r and (r.get('ms') or 0) > ex['timeLimitMs']:
                    problems.append(f"テスト「{test['name']}」：模範解答で {r['ms'] / 1000:.1f} 秒かかり、制限時間 {ex['timeLimitMs'] / 1000:g} 秒を超えます")
        lines = []
        if not problems:
            for i, x in enumerate(ex['alt']):
                rs, err = grade(ex, R.get(f'{k}:alt:{i}'))
                bad = [f'{n}（{w}）' for n, ok, w in (rs or []) if not ok]
                if err or bad:
                    problems.append(f"別解「{x['name']}」が不合格: {err or '、'.join(bad)}")
                else:
                    lines.append(f"    ✓ 別解「{x['name']}」：すべて合格")
            for i, x in enumerate(ex['wrong']):
                rs, err = grade(ex, R.get(f'{k}:wrong:{i}'))
                failed_tests = [n for n, ok, _ in (rs or []) if not ok]
                if not err and not failed_tests:
                    problems.append(f"誤答「{x['name']}」がすべてのテストに合格してしまいます（テストを足してください）")
                else:
                    lines.append(f"    ✓ 誤答「{x['name']}」：{'実行できない' if err else '、'.join(failed_tests) + ' で不合格'}")
        if problems:
            failed += 1
            print(f"✗ {t['name']}")
            for p in problems:
                print(f'    {p}')
            continue
        t['out'].write_text(public_json(ex, t['spec'], t['hash'], info), encoding='utf-8', newline='\n')
        print(f"✓ {t['name']} → {t['out'].name}（テスト {len(ex['tests'])} 件）")
        for line in lines:
            print(line)
    if failed:
        print(f'エラー {failed} 件（JSON を書いていません）')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
