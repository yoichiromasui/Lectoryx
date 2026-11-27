// =============================================================
// 演習の採点に使う値の共通形式と比較（実行エンジンから独立）
//   実行ツール（PC の公式 Julia。runner/pkgs/LectoryxWorker/src/JLValue.jl）と、将来のブラウザ内の
//   実行（SubsetJuliaVM の typed_value → fromSjulia）が同じ形で値を返し、期待値と許容誤差つきで比べる。
//   比較はブラウザ側で行う（学生のコードが比較の関数を書き換えても判定は変わらない）。
//
//   共通形式
//     { t:'num', v:数値|'NaN'|'Inf'|'-Inf'|'大きな整数の文字列', jt }
//     { t:'complex', re, im, jt }
//     { t:'bool', v }   { t:'str', v, jt }   { t:'nothing' }
//     { t:'array', shape:[…], data:[…（列優先）], jt }
//     { t:'tuple', items:[…], names? }
//     { t:'other', display, jt }
// =============================================================

/** julia_type の表記をそろえる（Array{Float64,1} → Vector{Float64}） */
export function normType(jt) {
  if (!jt) return '';
  return String(jt)
    .replace(/^Array\{(.+),\s*1\}$/, 'Vector{$1}')
    .replace(/^Array\{(.+),\s*2\}$/, 'Matrix{$1}')
    .replace(/Complex\{Float64\}/g, 'ComplexF64')
    .replace(/,\s+/g, ',');
}

const numVal = (v) => (typeof v === 'number' ? v : v === 'NaN' ? NaN : v === 'Inf' ? Infinity : v === '-Inf' ? -Infinity : Number(v));

/** SubsetJuliaVM の typed_value → 共通形式 */
export function fromSjulia(tv) {
  if (!tv || typeof tv !== 'object') return { t: 'other', display: String(tv) };
  const jt = normType(tv.julia_type);
  switch (tv.type) {
    case 'int': case 'float': return { t: 'num', v: tv.value, jt };
    case 'bool': return { t: 'bool', v: !!tv.value };
    case 'string': case 'char': case 'symbol': return { t: 'str', v: String(tv.value), jt };
    case 'complex': return { t: 'complex', re: tv.real, im: tv.imag, jt };
    case 'nothing': return { t: 'nothing' };
    case 'array': return { t: 'array', shape: tv.shape || [tv.length], data: (tv.elements || []).map(fromSjulia), jt };
    case 'tuple': return { t: 'tuple', items: (tv.elements || []).map(fromSjulia) };
    case 'named_tuple': return { t: 'tuple', items: (tv.fields || []).map((f) => fromSjulia(f.value)), names: (tv.fields || []).map((f) => f.name) };
    case 'struct':
      if (/^Rational\{/.test(tv.julia_type) && tv.fields && tv.fields.length === 2) {
        return { t: 'num', v: numVal(tv.fields[0].value.value) / numVal(tv.fields[1].value.value), jt };
      }
      return { t: 'other', display: tv.display, jt };
    case 'error': return { t: 'error', message: tv.message };
    default: return { t: 'other', display: tv.display, jt };
  }
}

/** 学生に見せる短い表示（Julia の repr に近い形） */
export function show(v, top = true) {
  if (!v) return '（値なし）';
  switch (v.t) {
    case 'num': return fmtNum(v.v, v.jt);
    case 'complex': return `${fmtNum(v.re, 'Float64')} ${numVal(v.im) < 0 || Object.is(numVal(v.im), -0) ? '-' : '+'} ${fmtNum(Math.abs(numVal(v.im)), 'Float64')}im`;
    case 'bool': return String(v.v);
    case 'str': return v.jt === 'Char' ? `'${v.v}'` : v.jt === 'Symbol' ? `:${v.v}` : JSON.stringify(v.v);
    case 'nothing': return 'nothing';
    case 'tuple': return `(${v.items.map((x, i) => (v.names ? `${v.names[i]} = ` : '') + show(x, false)).join(', ')}${v.items.length === 1 && !v.names ? ',' : ''})`;
    case 'array': {
      if (v.shape.length === 2) {
        const [m, n] = v.shape;
        const rows = [];
        for (let i = 0; i < m; i++) {
          const r = [];
          for (let j = 0; j < n; j++) r.push(show(v.data[j * m + i], false));
          rows.push(r.join(' '));
        }
        return `[${rows.join('; ')}]`;
      }
      const s = v.data.slice(0, 20).map((x) => show(x, false)).join(', ');
      return `[${s}${v.data.length > 20 ? ', …' : ''}]`;
    }
    case 'other': return v.display || '（表示できない値）';
    default: return JSON.stringify(v);
  }
}

function fmtNum(x, jt) {
  if (typeof x === 'string') return x;
  if (/^(Int|UInt|BigInt)/.test(jt || '')) return String(x);
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  return String(x);
}

function closeNum(a, b, rtol, atol) {
  const x = numVal(a), y = numVal(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) && Number.isNaN(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return x === y;
  if (typeof a === 'string' || typeof b === 'string') return String(a) === String(b);   // 大きな整数は文字列で厳密に
  return Math.abs(x - y) <= atol + rtol * Math.max(Math.abs(x), Math.abs(y));
}

function closeCx(a, b, rtol, atol) {
  const dr = numVal(a.re) - numVal(b.re), di = numVal(a.im) - numVal(b.im);
  const na = Math.hypot(numVal(a.re), numVal(a.im)), nb = Math.hypot(numVal(b.re), numVal(b.im));
  return Math.hypot(dr, di) <= atol + rtol * Math.max(na, nb);
}

const kindName = { num: '数値', complex: '複素数', bool: '真偽値', str: '文字列', nothing: 'nothing', array: '配列', tuple: 'タプル', other: '値' };
const shapeName = (v) => (v.shape.length === 1 ? `${v.shape[0]} 要素のベクトル` : v.shape.length === 2 ? `${v.shape[0]}×${v.shape[1]} の行列` : `${v.shape.join('×')} の配列`);

/**
 * actual（結果）と expected（期待値）を比べる。
 * opts: { rtol=1e-8, atol=1e-10, checkType=false }
 * 戻り値: { pass, message }（message は不合格の理由。学生に見せる）
 */
export function compareValues(actual, expected, opts = {}) {
  const rtol = opts.rtol ?? 1e-8;
  const atol = opts.atol ?? 1e-10;
  const fail = (message) => ({ pass: false, message });
  const rec = (a, e, path) => {
    const at = path ? `${path} の` : '';
    // 実数と虚部 0 の複素数は同じとみなす（型の確認は checkType で）
    if (a.t === 'num' && e.t === 'complex' && closeNum(e.im, 0, 0, atol)) return rec({ t: 'complex', re: a.v, im: 0 }, e, path);
    if (a.t === 'complex' && e.t === 'num' && closeNum(a.im, 0, 0, atol)) return rec(a, { t: 'complex', re: e.v, im: 0 }, path);
    if (a.t !== e.t) return fail(`${at}種類が違います（期待：${kindName[e.t] || e.t}、結果：${kindName[a.t] || a.t}）`);
    if (opts.checkType && e.jt && a.jt && normType(e.jt) !== normType(a.jt) && a.t !== 'tuple') {
      return fail(`${at}型が違います（期待：${normType(e.jt)}、結果：${normType(a.jt)}）`);
    }
    switch (e.t) {
      case 'num':
        return closeNum(a.v, e.v, rtol, atol) ? null : fail(`${at}値が違います（期待：${show(e)}、結果：${show(a)}）`);
      case 'complex':
        return closeCx(a, e, rtol, atol) ? null : fail(`${at}値が違います（期待：${show(e)}、結果：${show(a)}）`);
      case 'bool': case 'str':
        return a.v === e.v ? null : fail(`${at}値が違います（期待：${show(e)}、結果：${show(a)}）`);
      case 'nothing': return null;
      case 'array': {
        if (a.shape.join('x') !== e.shape.join('x')) return fail(`${at}形が違います（期待：${shapeName(e)}、結果：${shapeName(a)}）`);
        for (let i = 0; i < e.data.length; i++) {
          let idx;
          if (e.shape.length === 2) idx = `[${(i % e.shape[0]) + 1}, ${Math.floor(i / e.shape[0]) + 1}]`;
          else idx = `[${i + 1}]`;
          const r = rec(a.data[i], e.data[i], `${path || ''}${idx}`);
          if (r) return r;
        }
        return null;
      }
      case 'tuple': {
        if (a.items.length !== e.items.length) return fail(`${at}要素の数が違います（期待：${e.items.length}、結果：${a.items.length}）`);
        for (let i = 0; i < e.items.length; i++) {
          const r = rec(a.items[i], e.items[i], `${path || ''}${i + 1} 番目`);
          if (r) return r;
        }
        return null;
      }
      default:
        return (a.display || '') === (e.display || '') ? null : fail(`${at}値が違います（期待：${e.display}、結果：${a.display}）`);
    }
  };
  return rec(actual, expected, '') || { pass: true, message: '' };
}
