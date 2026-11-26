// =============================================================
// ストロークのデータ構造と描画
//
//   Stroke = { id, t:'pen'|'hl', c:'#rrggbb', w:基準線幅(論理px), p:[x0,y0,p0, x1,y1,p1, ...] }
//   座標は論理ページ座標（幅 PAGE_WIDTH）、p は筆圧 0..1（平滑化済み）。
//
// 描画は「中点を結ぶ二次ベジエ」で滑らかにする：
//   セグメント k（0..n-1）
//     k = 0     : P0 → M0（直線）
//     0<k<n-1   : M(k-1) → M(k)（制御点 Pk）
//     k = n-1   : M(n-2) → P(n-1)（直線）       Mi = (Pi + Pi+1) / 2
//   点 n-1 が追加された時点でセグメント 0..n-2 は確定し、
//   セグメント n-1 だけが暫定（次の点で形が変わる）になる。
//   入力中は確定セグメントを本レイヤーへ、暫定セグメントをライブレイヤーへ描く。
// =============================================================
import { NEUTRAL_PRESSURE } from '../config.js';

/**
 * 筆圧 → 線幅倍率。標準筆圧 NEUTRAL_PRESSURE で 1.0。
 * 保存済みデータの見た目を決めるので、変更する場合は形式のバージョンを上げること。
 */
export function pressureFactor(p) {
  const f = 0.35 + 0.65 * Math.sqrt((p > 0 ? p : 0) / NEUTRAL_PRESSURE);
  return f > 1.8 ? 1.8 : f;
}

export const pointCount = (s) => (s.p.length / 3) | 0;

export function pointWidth(s, i) {
  return s.t === 'hl' ? s.w : s.w * pressureFactor(s.p[i * 3 + 2]);
}

// ---- 外接矩形（点数が変わったら再計算） ----
const boundsCache = new WeakMap();

export function strokeBounds(s) {
  const p = s.p;
  const c = boundsCache.get(s);
  if (c && c.n === p.length) return c.b;
  const b = pointsBounds(s, 0, pointCount(s) - 1);
  boundsCache.set(s, { n: p.length, b });
  return b;
}

/** 点 i0..i1 の外接矩形（線幅込み） */
function pointsBounds(s, i0, i1) {
  const p = s.p;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, wmax = 0;
  for (let i = i0; i <= i1; i++) {
    const x = p[i * 3], y = p[i * 3 + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    const w = pointWidth(s, i);
    if (w > wmax) wmax = w;
  }
  const pad = wmax / 2 + 1.5;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** セグメント k0..k1-1 の外接矩形 */
export function segmentsBounds(s, k0, k1) {
  const n = pointCount(s);
  return pointsBounds(s, Math.max(0, k0 - 1), Math.min(n - 1, k1));
}

/** ストローク全体を描く */
export function drawStroke(ctx, s) {
  drawRange(ctx, s, 0, pointCount(s));
}

/** セグメント k0..k1-1 を描く（線幅がほぼ同じ連続セグメントは 1 パスにまとめる） */
export function drawRange(ctx, s, k0, k1) {
  const p = s.p;
  const n = pointCount(s);
  if (n === 0 || k0 >= k1) return;
  ctx.strokeStyle = s.c;
  ctx.fillStyle = s.c;
  if (n === 1) {
    if (k0 > 0) return;
    ctx.beginPath();
    ctx.arc(p[0], p[1], pointWidth(s, 0) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (k1 > n) k1 = n;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let open = false;
  let curW = 0;
  for (let k = k0; k < k1; k++) {
    const w = pointWidth(s, k);
    if (!open || Math.abs(w - curW) > curW * 0.025) {
      if (open) ctx.stroke();
      ctx.beginPath();
      ctx.lineWidth = curW = w;
      if (k === 0) ctx.moveTo(p[0], p[1]);
      else ctx.moveTo((p[3 * k - 3] + p[3 * k]) / 2, (p[3 * k - 2] + p[3 * k + 1]) / 2);
      open = true;
    }
    const j = 3 * k;
    if (k === n - 1) ctx.lineTo(p[j], p[j + 1]);
    else if (k === 0) ctx.lineTo((p[0] + p[3]) / 2, (p[1] + p[4]) / 2);
    else ctx.quadraticCurveTo(p[j], p[j + 1], (p[j] + p[j + 3]) / 2, (p[j + 1] + p[j + 4]) / 2);
  }
  if (open) ctx.stroke();
}

/** ストローク群の最下端（論理 y）。ページ高さの決定に使う */
export function strokesBottom(strokes) {
  let y = 0;
  for (const s of strokes) {
    const b = strokeBounds(s);
    if (b.y1 > y) y = b.y1;
  }
  return y;
}

/** 保存用に数値を丸める */
export const round1 = (v) => Math.round(v * 10) / 10;
export const round2 = (v) => Math.round(v * 100) / 100;
