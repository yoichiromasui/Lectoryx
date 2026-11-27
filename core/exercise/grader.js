// =============================================================
// 自動採点（実行エンジンから独立）
//   実行はエンジンに任せ、判定（期待値との比較・不合格の理由）はここで行う。
//
//   エンジンの約束（native.js。将来のブラウザ内の実行も同じ形にする）
//     engine.run(code, { timeoutMs, env, onOutput }) → Result
//     engine.runTests?(code, tests, { timeoutMs, env, onProgress }) → { base: Result, results: [Result] }
//         （なければ、テストごとに run(code + テスト) を呼ぶ）
//     Result = { ok, output, value（共通形式）, display, error: { type, message, line }, timedOut, stopped, ms }
//   値の共通形式と比較は value.js
// =============================================================
import { compareValues, show } from './value.js';

const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

/** runTests を持たないエンジン用：テストごとに「学生のコード＋テスト」を新しく実行する */
export async function runTestsOneByOne(engine, code, tests, opts = {}) {
  const base = await engine.run(code, opts);
  const results = [];
  if (!base.ok) return { base, results };
  for (let i = 0; i < tests.length; i++) {
    opts.onProgress?.(i);
    const r = await engine.run(code + tests[i].code, opts);
    if (r.output && r.output.startsWith(base.output)) r.output = r.output.slice(base.output.length);
    results.push(r);
  }
  return { base, results };
}

/**
 * 採点する。problem = { timeLimitMs, env, tests: [{ name, kind, code, expected?, expectedOutput?, rtol?, atol?, checkType?, hidden? }] }
 * 戻り値 { base, results: [{ name, kind, pass, message, actual, expected, hidden, ms }], passed, total }
 */
export async function grade(engine, problem, code, { onProgress } = {}) {
  const src = code.endsWith('\n') ? code : code + '\n';
  const tests = problem.tests.map((t) => ({ code: t.code.endsWith('\n') ? t.code : t.code + '\n', kind: t.kind }));
  const opts = { timeoutMs: problem.timeLimitMs || 5000, env: problem.envKey, onProgress };
  const { base, results: raw } = engine.runTests
    ? await engine.runTests(src, tests, opts)
    : await runTestsOneByOne(engine, src, tests, opts);
  const total = problem.tests.length;
  const results = [];
  if (!base.ok) {
    const why = base.timedOut ? '制限時間を超えました（学生のコードを実行している途中）' : `コードを実行できません: ${firstLine(base.error?.message)}`;
    for (const t of problem.tests) results.push({ name: t.name, kind: t.kind, pass: false, message: why, hidden: !!t.hidden, ms: 0 });
    return { base, results, passed: 0, total };
  }
  problem.tests.forEach((t, i) => {
    const r = raw[i] || { ok: false, error: { message: '実行されませんでした' } };
    const rec = { name: t.name, kind: t.kind, hidden: !!t.hidden, ms: r.ms, pass: false, message: '' };
    if (t.kind === 'error') {
      if (r.timedOut) rec.message = '制限時間を超えました';
      else if (r.ok) rec.message = 'エラーになるはずですが、エラーになりませんでした';
      else { rec.pass = true; rec.message = firstLine(r.error?.message); }
    } else if (r.timedOut) {
      rec.message = '制限時間を超えました。無限ループになっていないか確認してください';
    } else if (r.stopped) {
      rec.message = '止めました';
    } else if (!r.ok) {
      rec.message = `エラー: ${firstLine(r.error?.message)}`;
    } else if (t.kind === 'output') {
      const norm = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
      rec.pass = norm(r.output) === norm(t.expectedOutput);
      if (!rec.pass) rec.message = `表示が違います\n期待:\n${t.expectedOutput}\n結果:\n${r.output}`;
      rec.actual = r.output;
    } else if (!r.value) {
      rec.message = '結果の値を受け取れませんでした';
    } else if (t.kind === 'assert') {
      rec.pass = r.value.t === 'bool' && r.value.v === true;
      rec.actual = show(r.value);
      if (!rec.pass) rec.message = r.value.t === 'bool' ? '条件が成り立ちません（false）' : `true か false を返す式のはずが ${show(r.value)} でした`;
    } else {
      const c = compareValues(r.value, t.expected, { rtol: t.rtol, atol: t.atol, checkType: t.checkType });
      rec.pass = c.pass;
      rec.message = c.message;
      rec.actual = show(r.value);
      rec.expected = show(t.expected);
    }
    results.push(rec);
  });
  return { base, results, passed: results.filter((r) => r.pass).length, total };
}
