// =============================================================
// 手書きの描画レイヤー
//
// InkLayer : ページ全体を覆う「タイル分割キャンバス」。表示範囲付近のタイルだけ
//            確保し、画面外のタイルは解放する（板書スペースを長く拡張しても
//            メモリ使用量が一定）。座標は論理ページ座標。
// LiveLayer: 入力中ストロークの暫定セグメント（末尾）だけを描く小さな上書き層。
//
// 各キャンバスは変形（scale）されたページ要素の内側に置かれ、
// 実ピクセル解像度 r = scale × devicePixelRatio で描画する。
// =============================================================
import { TILE_HEIGHT, TILE_OVERLAP } from '../config.js';
import { drawStroke, drawRange, strokeBounds, segmentsBounds } from './stroke.js';
import { rect } from '../util.js';

const POOL_LIMIT = 6;

/** 論理座標の矩形を実ピクセル境界にそろえる（部分再描画の継ぎ目防止） */
function snap(b, r, originY) {
  return {
    x0: Math.floor(b.x0 * r) / r,
    x1: Math.ceil(b.x1 * r) / r,
    y0: originY + Math.floor((b.y0 - originY) * r) / r,
    y1: originY + Math.ceil((b.y1 - originY) * r) / r,
  };
}

export class InkLayer {
  /** kind: 'pen' | 'hl'（このレイヤーが描くストローク種別） */
  constructor(parent, kind) {
    this.kind = kind;
    this.el = document.createElement('div');
    this.el.className = `lw-ink lw-ink-${kind}`;
    parent.appendChild(this.el);
    this.tiles = new Map();
    this.pool = [];
    this.W = 0;
    this.H = 0;
    this.r = 1;
    this.strokes = [];
  }

  /** 表示するストローク配列（ページの配列への参照）を差し替える */
  setStrokes(strokes) {
    this.strokes = strokes;
    this.releaseAll();
  }

  setGeometry(W, H, r) {
    if (W !== this.W || Math.abs(r - this.r) > 1e-4) {
      this.W = W;
      this.H = H;
      this.r = r;
      this.releaseAll();
      return;
    }
    if (H !== this.H) {
      this.H = H;
      for (const [k, t] of [...this.tiles]) {
        const want = this.tileHeight(k);
        if (want <= 0 || Math.abs(want - t.h) > 1e-3) this.release(k);
      }
    }
  }

  tileHeight(k) {
    return Math.min(TILE_HEIGHT + TILE_OVERLAP, this.H - k * TILE_HEIGHT);
  }

  /** 論理 y 範囲 [top, bottom] を覆うタイルを確保し、それ以外を解放 */
  updateVisible(top, bottom) {
    if (this.H <= 0 || this.W <= 0) return;
    const last = Math.ceil(this.H / TILE_HEIGHT) - 1;
    const k0 = Math.max(0, Math.floor(top / TILE_HEIGHT));
    const k1 = Math.min(last, Math.floor(bottom / TILE_HEIGHT));
    for (const k of [...this.tiles.keys()]) if (k < k0 || k > k1) this.release(k);
    for (let k = k0; k <= k1; k++) if (!this.tiles.has(k)) this.alloc(k);
  }

  alloc(k) {
    const y0 = k * TILE_HEIGHT;
    const h = this.tileHeight(k);
    if (h <= 0) return;
    const r = this.r;
    const bw = Math.max(1, Math.round(this.W * r));
    const bh = Math.max(1, Math.round(h * r));
    const canvas = this.pool.pop() || document.createElement('canvas');
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.setTransform(r, 0, 0, r, 0, -y0 * r);
    canvas.style.top = y0 + 'px';
    canvas.style.width = this.W + 'px';
    canvas.style.height = bh / r + 'px';
    this.el.appendChild(canvas);
    const tile = { k, y0, h, canvas, ctx, box: { x0: 0, y0, x1: this.W, y1: y0 + bh / r } };
    this.tiles.set(k, tile);
    this.paint(tile, null);
  }

  release(k) {
    const t = this.tiles.get(k);
    if (!t) return;
    t.canvas.remove();
    this.tiles.delete(k);
    if (this.pool.length < POOL_LIMIT) this.pool.push(t.canvas);
    else t.canvas.width = t.canvas.height = 0; // メモリを即時解放
  }

  releaseAll() {
    for (const k of [...this.tiles.keys()]) this.release(k);
  }

  /** タイルの region（null なら全体）を消去して描き直す */
  paint(tile, region) {
    let b = region ? rect.intersect(region, tile.box) : tile.box;
    if (!b) return;
    b = snap(b, this.r, tile.y0);
    const ctx = tile.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    ctx.clip();
    ctx.clearRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    for (const s of this.strokes) {
      if (s.t === this.kind && rect.intersects(strokeBounds(s), b)) drawStroke(ctx, s);
    }
    ctx.restore();
  }

  /** 確保済みタイルの region（null なら全体）を描き直す */
  redraw(region) {
    for (const t of this.tiles.values()) this.paint(t, region);
  }

  /** 入力中ストロークのセグメント k0..k1-1 を追記する */
  drawSegments(s, k0, k1) {
    if (k1 <= k0) return;
    const b = segmentsBounds(s, k0, k1);
    for (const t of this.tiles.values()) {
      if (rect.intersects(b, t.box)) drawRange(t.ctx, s, k0, k1);
    }
  }
}

export class LiveLayer {
  constructor(parent) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lw-ink lw-ink-live';
    this.canvas.width = this.canvas.height = 1;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.top = 0;
    this.r = 1;
    this.dirty = null;
  }

  /** 表示中の範囲（論理 y: top から高さ h）を覆うように配置する */
  place(top, h, W, r) {
    const bw = Math.max(1, Math.round(W * r));
    const bh = Math.max(1, Math.round(h * r));
    const c = this.canvas;
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
    } else {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, bw, bh);
    }
    c.style.top = top + 'px';
    c.style.width = W + 'px';
    c.style.height = bh / r + 'px';
    this.top = top;
    this.r = r;
    this.ctx.setTransform(r, 0, 0, r, 0, -top * r);
    this.dirty = null;
  }

  setBlend(multiply) {
    this.canvas.classList.toggle('lw-blend', !!multiply);
  }

  /** 暫定セグメント k を描く（前回の暫定描画は消す） */
  drawTail(s, k) {
    this.clear();
    drawRange(this.ctx, s, k, k + 1);
    this.dirty = segmentsBounds(s, k, k + 1);
  }

  clear() {
    if (!this.dirty) return;
    const b = snap(rect.pad(this.dirty, 1), this.r, this.top);
    this.ctx.clearRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    this.dirty = null;
  }
}
