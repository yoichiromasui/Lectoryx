// 数値計算の小さな道具箱（ウィジェットから w.math として使える）

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;

/** a から b まで n 点 */
export function linspace(a, b, n = 100) {
  if (n < 2) return [a];
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

/** a 以上 b 未満を step 刻み */
export function range(a, b, step = 1) {
  const out = [];
  if (step > 0) for (let x = a; x < b - 1e-12; x += step) out.push(x);
  else if (step < 0) for (let x = a; x > b + 1e-12; x += step) out.push(x);
  return out;
}

/**
 * 4 次ルンゲ＝クッタ法で dy/dt = f(t, y) を解く。y はスカラーまたは配列。
 * @returns {{ t: number[], y: (number|number[])[] }}
 */
export function rk4(f, y0, t0, t1, n = 200) {
  const isArr = Array.isArray(y0);
  const add = isArr ? (a, b, k) => a.map((v, i) => v + b[i] * k) : (a, b, k) => a + b * k;
  const h = (t1 - t0) / n;
  const ts = [t0];
  const ys = [y0];
  let t = t0;
  let y = y0;
  for (let i = 0; i < n; i++) {
    const k1 = f(t, y);
    const k2 = f(t + h / 2, add(y, k1, h / 2));
    const k3 = f(t + h / 2, add(y, k2, h / 2));
    const k4 = f(t + h, add(y, k3, h));
    y = isArr
      ? y.map((v, j) => v + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]))
      : y + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    t = t0 + h * (i + 1);
    ts.push(t);
    ys.push(y);
  }
  return { t: ts, y: ys };
}

// ---- 複素数 { re, im } ----
export const cx = (re, im = 0) => ({ re, im });
export const cadd = (a, b) => cx(a.re + b.re, a.im + b.im);
export const csub = (a, b) => cx(a.re - b.re, a.im - b.im);
export const cmul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export function cdiv(a, b) {
  const d = b.re * b.re + b.im * b.im;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
}
export const cabs = (a) => Math.hypot(a.re, a.im);
export const carg = (a) => Math.atan2(a.im, a.re);
export const cconj = (a) => cx(a.re, -a.im);
export const cpolar = (r, th) => cx(r * Math.cos(th), r * Math.sin(th));
export function cexp(a) {
  const e = Math.exp(a.re);
  return cx(e * Math.cos(a.im), e * Math.sin(a.im));
}
/** 2 次方程式 a s^2 + b s + c = 0 の根（複素数 2 つ） */
export function roots2(a, b, c) {
  const D = b * b - 4 * a * c;
  if (D >= 0) {
    const r = Math.sqrt(D);
    return [cx((-b + r) / (2 * a)), cx((-b - r) / (2 * a))];
  }
  const r = Math.sqrt(-D);
  return [cx(-b / (2 * a), r / (2 * a)), cx(-b / (2 * a), -r / (2 * a))];
}

/** 数値の表示用整形（負号は U+2212） */
export function fmt(x, digits = 2) {
  if (!Number.isFinite(x)) return String(x);
  const s = x.toFixed(digits);
  return (/^-0(\.0*)?$/.test(s) ? s.slice(1) : s).replace('-', '−');
}

/** 複素数の表示 a ± jb（制御工学の慣例で j） */
export function cfmt(z, digits = 2, unit = 'j') {
  const re = fmt(z.re, digits);
  const im = Math.abs(z.im);
  if (im < 10 ** -digits / 2) return re;
  return `${re} ${z.im < 0 ? '−' : '+'} ${unit}${fmt(im, digits)}`;
}
