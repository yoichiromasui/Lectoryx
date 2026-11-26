// 消しゴムの幾何計算（ストローク単位の判定・部分消去の分割）
import { strokeBounds, pointCount, pressureFactor, round1, round2 } from './stroke.js';
import { uid } from '../util.js';

function distSeg2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

function cross(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segSegDist2(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = cross(ax, ay, bx, by, cx, cy), d2 = cross(ax, ay, bx, by, dx, dy);
  const d3 = cross(cx, cy, dx, dy, ax, ay), d4 = cross(cx, cy, dx, dy, bx, by);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    distSeg2(ax, ay, cx, cy, dx, dy), distSeg2(bx, by, cx, cy, dx, dy),
    distSeg2(cx, cy, ax, ay, bx, by), distSeg2(dx, dy, ax, ay, bx, by),
  );
}

const halfWidth = (s, pr) => (s.t === 'hl' ? s.w : s.w * pressureFactor(pr)) / 2;

/** 消しゴムの移動線分 A→B（半径 r）がストロークに触れるか */
export function strokeHit(s, ax, ay, bx, by, r) {
  const b = strokeBounds(s);
  if (Math.max(ax, bx) + r < b.x0 || Math.min(ax, bx) - r > b.x1 ||
      Math.max(ay, by) + r < b.y0 || Math.min(ay, by) - r > b.y1) return false;
  const p = s.p;
  const n = pointCount(s);
  if (n === 1) {
    const rr = r + halfWidth(s, p[2]);
    return distSeg2(p[0], p[1], ax, ay, bx, by) <= rr * rr;
  }
  for (let i = 0; i < n - 1; i++) {
    const j = i * 3;
    const rr = r + halfWidth(s, p[j + 2]);
    if (segSegDist2(ax, ay, bx, by, p[j], p[j + 1], p[j + 3], p[j + 4]) <= rr * rr) return true;
  }
  return false;
}

/**
 * 部分消去：消しゴムが触れた部分を取り除き、残りを新しいストロークに分割する。
 * @returns {Stroke[]|null} 置き換え後のストローク（空配列 = 全消去）。変化なしは null。
 */
export function splitStroke(s, ax, ay, bx, by, r) {
  const src = s.p;
  const n = pointCount(s);
  if (n === 1) return strokeHit(s, ax, ay, bx, by, r) ? [] : null;

  // 消しゴム付近のセグメントだけ点を補間して密にする（長い線分の途中を消せるように）
  const spacing = Math.max(1, r / 3);
  const pts = [src[0], src[1], src[2]];
  for (let i = 0; i < n - 1; i++) {
    const j = i * 3;
    const x0 = src[j], y0 = src[j + 1], p0 = src[j + 2];
    const x1 = src[j + 3], y1 = src[j + 4], p1 = src[j + 5];
    const reach = r + halfWidth(s, Math.max(p0, p1)) + spacing;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len > spacing && segSegDist2(ax, ay, bx, by, x0, y0, x1, y1) <= reach * reach) {
      const m = Math.ceil(len / spacing);
      for (let k = 1; k < m; k++) {
        const t = k / m;
        pts.push(round1(x0 + (x1 - x0) * t), round1(y0 + (y1 - y0) * t), round2(p0 + (p1 - p0) * t));
      }
    }
    pts.push(x1, y1, p1);
  }

  const m = pts.length / 3;
  const keep = new Uint8Array(m);
  let removedAny = false;
  for (let i = 0; i < m; i++) {
    const rr = r + halfWidth(s, pts[i * 3 + 2]) * 0.5;
    const hit = distSeg2(pts[i * 3], pts[i * 3 + 1], ax, ay, bx, by) <= rr * rr;
    keep[i] = hit ? 0 : 1;
    if (hit) removedAny = true;
  }
  if (!removedAny) return null;

  const pieces = [];
  let start = -1;
  for (let i = 0; i <= m; i++) {
    if (i < m && keep[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= 2) pieces.push({ id: uid(), t: s.t, c: s.c, w: s.w, p: pts.slice(start * 3, i * 3) });
      start = -1;
    }
  }
  return pieces;
}
