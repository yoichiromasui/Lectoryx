// =============================================================
// レーザーポインタ（GoodNotes のレーザーポインタに準じる）
//   軌跡モード：光る線を描き、ペンを離して LASER_HOLD_MS 経つと全体がフェードアウト。
//               消え切る前に続けて描けば（フェード中でも）元に戻り、まとめて残る（丸で囲んでから下線、など）。
//   点モード  ：ペン先に光点を表示し、離すとすぐ消える。
// 書き込みデータ・Undo・保存・PDF には一切含まれない。
// キャンバスは表示中の範囲だけを覆い、論理ページ座標で描く（スクロールしても教材に追従）。
// =============================================================
import { LASER_HOLD_MS, LASER_FADE_MS, LASER_DOT_FADE_MS, PAGE_WIDTH } from '../config.js';

export class LaserLayer {
  /** view: visibleRange() と inkResolution を持つもの */
  constructor(parent, view) {
    this.view = view;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lw-ink lw-ink-laser';
    this.canvas.width = this.canvas.height = 1;
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.strokes = [];      // { c, pts:[x,y,...] }
    this.dot = null;        // { x, y, c, up }
    this.down = false;
    this.lastUp = 0;
    this.raf = 0;
    this.dirty = false;
    this.geom = { top: NaN, h: 0, r: 0 };
  }

  get active() { return this.down || this.strokes.length > 0 || !!this.dot; }

  begin(pt, mode, color) {
    const now = performance.now();
    this.down = true;
    this.mode = mode;
    if (mode === 'dot') {
      this.dot = { x: pt.x, y: pt.y, c: color, up: 0 };
    } else {
      // 消えかけ（フェード中）なら古い軌跡も残し、描いている間は不透明に戻る。
      // 消え切った後（rAF が止まっていた場合も含む）は捨てる。
      if (this.strokes.length && now - this.lastUp >= LASER_HOLD_MS + LASER_FADE_MS) this.strokes = [];
      this.strokes.push({ c: color, pts: [pt.x, pt.y] });
    }
    this.dirty = true;
    this._kick();
  }

  move(pts) {
    if (!this.down) return;
    if (this.mode === 'dot') {
      const p = pts[pts.length - 1];
      this.dot.x = p.x;
      this.dot.y = p.y;
    } else {
      const s = this.strokes[this.strokes.length - 1];
      for (const p of pts) {
        const n = s.pts.length;
        const dx = p.x - s.pts[n - 2], dy = p.y - s.pts[n - 1];
        if (dx * dx + dy * dy >= 0.64) s.pts.push(p.x, p.y);
      }
    }
    this.dirty = true;
    this._kick();
  }

  end() {
    if (!this.down) return;
    this.down = false;
    this.lastUp = performance.now();
    if (this.dot) this.dot.up = this.lastUp;
    this._kick();
  }

  /** ページ切替時などに即座に消す */
  clear() {
    this.strokes = [];
    this.dot = null;
    this.down = false;
    this._clearCanvas();
  }

  _kick() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this._frame(t));
  }

  _frame() {
    this.raf = 0;
    const now = performance.now();
    let alpha = 1;
    if (!this.down && this.strokes.length) {
      const t = now - this.lastUp - LASER_HOLD_MS;
      if (t > 0) {
        alpha = 1 - t / LASER_FADE_MS;
        if (alpha <= 0) { this.strokes = []; alpha = 0; }
        this.dirty = true;
      }
    }
    let dotAlpha = 1;
    if (this.dot && this.dot.up) {
      dotAlpha = 1 - (now - this.dot.up) / LASER_DOT_FADE_MS;
      if (dotAlpha <= 0) this.dot = null;
      this.dirty = true;
    }
    if (this._place()) this.dirty = true;
    if (this.dirty) {
      this.dirty = false;
      this._clearCanvas();
      const c = this.ctx;
      for (const s of this.strokes) drawGlowPath(c, s.pts, s.c, alpha);
      if (this.dot) drawGlowDot(c, this.dot.x, this.dot.y, this.dot.c, dotAlpha);
    }
    if (this.active) this._kick();
  }

  /** 表示範囲に合わせてキャンバスを配置。変わったら true */
  _place() {
    const { top, bottom } = this.view.visibleRange();
    const r = this.view.inkResolution;
    const h = bottom - top;
    const g = this.geom;
    if (Math.abs(g.top - top) < 0.5 && Math.abs(g.h - h) < 0.5 && g.r === r) return false;
    const cv = this.canvas;
    const bw = Math.max(1, Math.round(PAGE_WIDTH * r));
    const bh = Math.max(1, Math.round(h * r));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    cv.style.top = top + 'px';
    cv.style.width = PAGE_WIDTH + 'px';
    cv.style.height = bh / r + 'px';
    this.geom = { top, h, r };
    return true;
  }

  _clearCanvas() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const { top, r } = this.geom;
    if (r) c.setTransform(r, 0, 0, r, 0, -top * r);
  }
}

function tracePath(c, p) {
  const n = p.length / 2;
  c.beginPath();
  c.moveTo(p[0], p[1]);
  if (n === 1) { c.lineTo(p[0] + 0.01, p[1]); return; }
  for (let i = 1; i < n - 1; i++) {
    const x = p[2 * i], y = p[2 * i + 1];
    c.quadraticCurveTo(x, y, (x + p[2 * i + 2]) / 2, (y + p[2 * i + 3]) / 2);
  }
  c.lineTo(p[2 * n - 2], p[2 * n - 1]);
}

/** 光る線：外側のにじみ → 色の芯 → 白い中心 */
function drawGlowPath(c, pts, color, alpha) {
  if (alpha <= 0) return;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  tracePath(c, pts);
  c.strokeStyle = color;
  c.globalAlpha = 0.18 * alpha;
  c.lineWidth = 18;
  c.stroke();
  c.globalAlpha = 0.5 * alpha;
  c.lineWidth = 8;
  c.stroke();
  c.globalAlpha = 0.95 * alpha;
  c.lineWidth = 4;
  c.stroke();
  c.strokeStyle = '#ffffff';
  c.globalAlpha = 0.85 * alpha;
  c.lineWidth = 1.6;
  c.stroke();
  c.restore();
}

function rgba(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(255,42,42,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

function drawGlowDot(c, x, y, color, alpha) {
  if (alpha <= 0) return;
  c.save();
  c.globalAlpha = alpha;
  const g = c.createRadialGradient(x, y, 0, x, y, 18);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.22, '#ffffff');
  g.addColorStop(0.35, color);
  g.addColorStop(0.6, rgba(color, 0.35));
  g.addColorStop(1, rgba(color, 0));
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, 18, 0, Math.PI * 2);
  c.fill();
  c.restore();
}
