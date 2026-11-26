// =============================================================
// 軽量 2D プロット（Canvas）
//
// 論理サイズ（width × height, 論理px）で配置し、表示倍率 × devicePixelRatio の
// 解像度で描く。ウィジェットの render() のたびに軸から描き直す（即時モード）。
// 数式ラベル（$...$）は KaTeX で HTML として重ねる。
// 点のドラッグ（handle）は指・マウスで操作。ペンも点の真上から始めればドラッグになる。
// =============================================================
import { h, clamp } from '../util.js';

export const PALETTE = {
  blue: '#1f5fd6', red: '#d62828', green: '#138a36', orange: '#e07b00',
  purple: '#7b3fbf', teal: '#0a8f8f', gray: '#80858f', black: '#1b1b1f',
};
const CYCLE = ['blue', 'red', 'green', 'orange', 'purple', 'teal'];

export function color(c, i = 0) {
  if (!c) return PALETTE[CYCLE[i % CYCLE.length]];
  return PALETTE[c] || c;
}

const FONT = '"KaTeX_Main", "Times New Roman", serif';

const ANCHORS = {
  c: [-50, -50, 0, 0], n: [-50, -100, 0, -6], s: [-50, 0, 0, 6], e: [0, -50, 8, 0], w: [-100, -50, -8, 0],
  ne: [0, -100, 6, -4], nw: [-100, -100, -6, -4], se: [0, 0, 6, 4], sw: [-100, 0, -6, 4],
};

/** 素のキャンバス（w.canvas）。ctx は論理px 座標。描画のたびに消去される */
export class Surface {
  constructor(o, w) {
    this.w = w;
    this.o = o;
    const avail = w.displayEl.clientWidth || 640;
    this.width = Math.round(o.width ?? Math.min(avail, 880));
    this.height = Math.round(o.height ?? Math.max(220, this.width * 0.5));
    this.canvas = h('canvas', { class: 'lw-surface-canvas' });
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    this.el = h('div', { class: 'lw-surface', style: { width: this.width + 'px', height: this.height + 'px' } }, this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.r = 1;
  }
  resize() {
    const r = Math.min(4, Math.max(1, this.w.env.scale * this.w.env.dpr));
    this.r = r;
    const bw = Math.round(this.width * r);
    const bh = Math.round(this.height * r);
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
  }
  _begin() {
    const c = this.ctx;
    c.setTransform(this.r, 0, 0, this.r, 0, 0);
    c.clearRect(0, 0, this.width, this.height);
  }
  _end() {}
}

function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

function makeTicks(a, b, spec, count) {
  if (spec === false) return { values: [], step: 1 };
  if (Array.isArray(spec)) return { values: spec.filter((v) => v >= a - 1e-9 && v <= b + 1e-9), step: 0 };
  const step = typeof spec === 'number' && spec > 0 ? spec : niceStep(b - a, count);
  const values = [];
  const k0 = Math.ceil(a / step - 1e-9);
  const k1 = Math.floor(b / step + 1e-9);
  for (let k = k0; k <= k1 && values.length < 200; k++) values.push(k === 0 ? 0 : k * step);
  return { values, step };
}

function tickText(v, step) {
  let s;
  if (step > 0) s = v.toFixed(clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 6));
  else s = String(Number(v.toFixed(4)));
  return s.replace(/^-/, '−');
}

export class Plot extends Surface {
  /**
   * o: { width, height, x:[min,max], y:[min,max], xlabel, ylabel, title,
   *      grid=true, equal=false, axes:'box'|'cross', xticks, yticks, xtickFormat, ytickFormat,
   *      legend:'ne'|'nw'|'se'|'sw'|false, margin:{l,r,t,b} }
   */
  constructor(o, w) {
    super(o, w);
    this.el.classList.add('lw-plot');
    this.xr = (o.x || [0, 1]).slice();
    this.yr = (o.y || [0, 1]).slice();
    this.equal = !!o.equal;
    this.grid = o.grid !== false;
    this.axes = o.axes || 'box';
    const cross = this.axes === 'cross';
    this.m = {
      l: cross ? 16 : 54, r: cross ? 16 : 18,
      t: o.title || (o.ylabel && !cross) ? 36 : 14,
      b: cross ? 16 : o.xlabel ? 58 : 32,
      ...(o.margin || {}),
    };
    this.overlay = h('div', { class: 'lw-plot-overlay' });
    this.el.appendChild(this.overlay);
    this._static = {};
    for (const k of ['title', 'xlabel', 'ylabel']) {
      if (o[k]) {
        this._static[k] = h('div', { class: `lw-plot-label lw-plot-${k}`, html: w.env.renderer.inline(o[k]) });
        this.overlay.appendChild(this._static[k]);
      }
    }
    this._labels = [];
    this._used = 0;
    this._legend = [];
    this._legendKey = null;
    this._legendEl = null;
    this._handles = [];
    this._series = 0;
    this._drag = null;
    this._computeTransform();
    this._initPointer();
  }

  /** 表示範囲を変更 */
  setRange({ x, y } = {}) {
    if (x) this.xr = x.slice();
    if (y) this.yr = y.slice();
    this.w.invalidate();
    return this;
  }

  _computeTransform() {
    const { l, r, t, b } = this.m;
    const pw = this.width - l - r;
    const ph = this.height - t - b;
    let [x0, x1] = this.xr;
    let [y0, y1] = this.yr;
    if (this.equal) {
      const sx = pw / (x1 - x0), sy = ph / (y1 - y0);
      if (sx < sy) { const c = (y0 + y1) / 2, hh = ph / sx / 2; y0 = c - hh; y1 = c + hh; }
      else { const c = (x0 + x1) / 2, hw = pw / sy / 2; x0 = c - hw; x1 = c + hw; }
    }
    this.vx = [x0, x1];
    this.vy = [y0, y1];
    this.sx = pw / (x1 - x0);
    this.sy = ph / (y1 - y0);
    this.box = { x: l, y: t, w: pw, h: ph };
  }

  // ---- 座標変換（データ ↔ 論理px） ----
  X(x) { return this.box.x + (x - this.vx[0]) * this.sx; }
  Y(y) { return this.box.y + this.box.h - (y - this.vy[0]) * this.sy; }
  invX(px) { return this.vx[0] + (px - this.box.x) / this.sx; }
  invY(py) { return this.vy[0] + (this.box.y + this.box.h - py) / this.sy; }

  _begin() {
    super._begin();
    this._computeTransform();
    this._used = 0;
    this._series = 0;
    this._legend = [];
    this._drawAxes();
  }

  _end() {
    this._drawHandles();
    this._drawLegend();
    for (let i = this._used; i < this._labels.length; i++) this._labels[i].style.display = 'none';
  }

  _drawAxes() {
    const c = this.ctx;
    const { x, y, w, h: hh } = this.box;
    const o = this.o;
    const cross = this.axes === 'cross';
    const xt = makeTicks(this.vx[0], this.vx[1], o.xticks, w / 90);
    const yt = makeTicks(this.vy[0], this.vy[1], o.yticks, hh / 56);
    const fx = o.xtickFormat || ((v) => tickText(v, xt.step));
    const fy = o.ytickFormat || ((v) => tickText(v, yt.step));
    c.save();
    c.fillStyle = '#ffffff';
    c.fillRect(x, y, w, hh);
    if (this.grid) {
      c.strokeStyle = '#e3e5ea';
      c.lineWidth = 1;
      c.beginPath();
      for (const v of xt.values) { const px = this.X(v); c.moveTo(px, y); c.lineTo(px, y + hh); }
      for (const v of yt.values) { const py = this.Y(v); c.moveTo(x, py); c.lineTo(x + w, py); }
      c.stroke();
    }
    const x0in = this.vx[0] <= 0 && this.vx[1] >= 0;
    const y0in = this.vy[0] <= 0 && this.vy[1] >= 0;
    c.strokeStyle = '#555a65';
    c.lineWidth = 1.4;
    c.beginPath();
    if (x0in) { c.moveTo(this.X(0), y); c.lineTo(this.X(0), y + hh); }
    if (y0in) { c.moveTo(x, this.Y(0)); c.lineTo(x + w, this.Y(0)); }
    c.stroke();
    c.fillStyle = '#3a3f49';
    c.font = `16px ${FONT}`;
    if (cross) {
      // 原点を通る軸＋矢印、目盛りは軸沿い
      c.fillStyle = '#555a65';
      if (y0in) arrowHead(c, x + w, this.Y(0), 0, 9);
      if (x0in) arrowHead(c, this.X(0), y, -Math.PI / 2, 9);
      c.fillStyle = '#3a3f49';
      const ax = x0in ? this.X(0) : x;
      const ay = y0in ? this.Y(0) : y + hh;
      c.textAlign = 'center';
      c.textBaseline = 'top';
      for (const v of xt.values) if (v !== 0) c.fillText(fx(v), this.X(v), ay + 5);
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      for (const v of yt.values) if (v !== 0) c.fillText(fy(v), ax - 6, this.Y(v));
      if (x0in && y0in) { c.textAlign = 'right'; c.textBaseline = 'top'; c.fillText('0', ax - 4, ay + 4); }
    } else {
      c.strokeStyle = '#9aa0ab';
      c.lineWidth = 1;
      c.strokeRect(x, y, w, hh);
      c.textAlign = 'center';
      c.textBaseline = 'top';
      for (const v of xt.values) c.fillText(fx(v), this.X(v), y + hh + 6);
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      for (const v of yt.values) c.fillText(fy(v), x - 7, this.Y(v));
    }
    c.restore();
    this._placeStatic();
  }

  _placeStatic() {
    const { x, y, w, h: hh } = this.box;
    const s = this._static;
    const cross = this.axes === 'cross';
    const put = (el, left, top, tx, ty) => {
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.transform = `translate(${tx}%, ${ty}%)`;
    };
    if (s.title) put(s.title, x + w / 2, 4, -50, 0);
    if (cross) {
      const ay = this.vy[0] <= 0 && this.vy[1] >= 0 ? this.Y(0) : y + hh;
      const ax = this.vx[0] <= 0 && this.vx[1] >= 0 ? this.X(0) : x;
      if (s.xlabel) put(s.xlabel, x + w - 4, ay - 6, -100, -100);
      if (s.ylabel) put(s.ylabel, ax + 10, y + 2, 0, 0);
    } else {
      if (s.xlabel) put(s.xlabel, x + w / 2, y + hh + 28, -50, 0);
      if (s.ylabel) put(s.ylabel, Math.max(2, x - this.m.l + 4), y - 6, 0, -100);
    }
  }

  // ---- 描画 API（すべてデータ座標。this を返すので連鎖可） ----
  _style(o, kind = 'line') {
    const c = this.ctx;
    const col = color(o.color, this._series++);
    c.strokeStyle = col;
    c.fillStyle = col;
    c.lineWidth = o.width ?? 2.5;
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.setLineDash(o.dash === true ? [8, 6] : Array.isArray(o.dash) ? o.dash : []);
    c.globalAlpha = o.alpha ?? 1;
    if (o.label) this._legend.push({ label: o.label, color: col, dash: !!o.dash, kind });
    return col;
  }

  _clip() {
    const c = this.ctx;
    const { x, y, w, h: hh } = this.box;
    c.save();
    c.beginPath();
    c.rect(x, y, w, hh);
    c.clip();
  }

  _poly(pts, close = false) {
    const c = this.ctx;
    c.beginPath();
    let pen = false;
    for (const [px, py] of pts) {
      if (!Number.isFinite(px) || !Number.isFinite(py)) { pen = false; continue; }
      const X = clamp(this.X(px), -1e4, 1e4), Y = clamp(this.Y(py), -1e4, 1e4);
      if (pen) c.lineTo(X, Y); else { c.moveTo(X, Y); pen = true; }
    }
    if (close) c.closePath();
  }

  /** y = f(x) のグラフ。o: { color, width, dash, alpha, label, domain:[a,b], samples } */
  fn(f, o = {}) {
    const [a, b] = o.domain || this.vx;
    const n = o.samples || Math.max(60, Math.ceil(this.box.w / 1.5));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const x = a + ((b - a) * i) / n;
      pts.push([x, f(x)]);
    }
    return this.path(pts, o);
  }

  /** 媒介変数表示 (x(t), y(t))。o: { domain:[t0,t1], samples } */
  param(fx, fy, o = {}) {
    const [a, b] = o.domain || [0, 1];
    const n = o.samples || 300;
    const pts = [];
    for (let i = 0; i <= n; i++) { const t = a + ((b - a) * i) / n; pts.push([fx(t), fy(t)]); }
    return this.path(pts, o);
  }

  /** 折れ線（配列 xs, ys） */
  line(xs, ys, o = {}) {
    return this.path(xs.map((x, i) => [x, ys[i]]), o);
  }

  /** 折れ線（[[x,y], ...]） */
  path(pts, o = {}) {
    this._clip();
    this._style(o);
    this._poly(pts.map((p) => (Array.isArray(p) ? p : [p.x, p.y])));
    this.ctx.stroke();
    this.ctx.restore();
    return this;
  }

  /** 塗りつぶし領域：関数 f と y=base の間、または多角形 */
  area(f, o = {}) {
    let pts;
    if (typeof f === 'function') {
      const [a, b] = o.domain || this.vx;
      const n = o.samples || 200;
      const base = o.base ?? 0;
      pts = [[a, base]];
      for (let i = 0; i <= n; i++) { const x = a + ((b - a) * i) / n; pts.push([x, f(x)]); }
      pts.push([b, base]);
    } else {
      pts = f.map((p) => (Array.isArray(p) ? p : [p.x, p.y]));
    }
    this._clip();
    this._style({ alpha: 0.18, ...o, label: o.label }, 'area');
    this._poly(pts, true);
    this.ctx.fill();
    this.ctx.restore();
    return this;
  }

  /** 点。o: { color, radius, hollow, label, anchor } */
  point(x, y, o = {}) {
    const c = this.ctx;
    this._clip();
    this._style({ width: 2, ...o, label: o.legend }, 'point');
    c.setLineDash([]);
    c.beginPath();
    c.arc(this.X(x), this.Y(y), o.radius ?? 5, 0, Math.PI * 2);
    if (o.hollow) { c.fillStyle = '#fff'; c.fill(); c.stroke(); } else c.fill();
    c.restore();
    if (o.label) this.label(x, y, o.label, { anchor: o.anchor || 'ne', color: o.labelColor });
    return this;
  }

  points(pts, o = {}) {
    for (const p of pts) this.point(Array.isArray(p) ? p[0] : p.x, Array.isArray(p) ? p[1] : p.y, { ...o, label: undefined, legend: undefined });
    if (o.legend) this._legend.push({ label: o.legend, color: color(o.color), kind: 'point' });
    return this;
  }

  hline(y, o = {}) {
    return this.path([[this.vx[0], y], [this.vx[1], y]], { color: 'gray', width: 1.5, ...o });
  }

  vline(x, o = {}) {
    return this.path([[x, this.vy[0]], [x, this.vy[1]]], { color: 'gray', width: 1.5, ...o });
  }

  segment(x0, y0, x1, y1, o = {}) {
    return this.path([[x0, y0], [x1, y1]], o);
  }

  /** 矢印 (x0,y0)→(x1,y1)。o.head: 矢じりの大きさ(px) */
  arrow(x0, y0, x1, y1, o = {}) {
    const c = this.ctx;
    this._clip();
    this._style({ width: 2.2, ...o });
    const X0 = this.X(x0), Y0 = this.Y(y0), X1 = this.X(x1), Y1 = this.Y(y1);
    const ang = Math.atan2(Y1 - Y0, X1 - X0);
    const hs = o.head ?? 11;
    c.beginPath();
    c.moveTo(X0, Y0);
    c.lineTo(X1 - Math.cos(ang) * hs * 0.6, Y1 - Math.sin(ang) * hs * 0.6);
    c.stroke();
    c.setLineDash([]);
    arrowHead(c, X1, Y1, ang, hs);
    c.restore();
    return this;
  }

  /** 円（データ座標の半径。equal でない場合は楕円になる）。o.fill: 塗り色 or true */
  circle(cx, cy, r, o = {}) {
    const c = this.ctx;
    this._clip();
    const col = this._style({ width: 2, ...o });
    c.beginPath();
    c.ellipse(this.X(cx), this.Y(cy), Math.abs(r * this.sx), Math.abs(r * this.sy), 0, 0, Math.PI * 2);
    if (o.fill) { c.fillStyle = o.fill === true ? col : color(o.fill); c.globalAlpha = o.fillAlpha ?? 0.15; c.fill(); c.globalAlpha = o.alpha ?? 1; }
    if (o.stroke !== false) c.stroke();
    c.restore();
    return this;
  }

  rect(x0, y0, x1, y1, o = {}) {
    return this.polygon([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], o);
  }

  polygon(pts, o = {}) {
    const c = this.ctx;
    this._clip();
    const col = this._style({ width: 2, ...o });
    this._poly(pts.map((p) => (Array.isArray(p) ? p : [p.x, p.y])), true);
    if (o.fill) { c.fillStyle = o.fill === true ? col : color(o.fill); c.globalAlpha = o.fillAlpha ?? 0.15; c.fill(); c.globalAlpha = o.alpha ?? 1; }
    if (o.stroke !== false) c.stroke();
    c.restore();
    return this;
  }

  /** キャンバス上の文字（高速。数式は label を使う）。o: { color, size, align, baseline, offset:[dx,dy] } */
  text(x, y, str, o = {}) {
    const c = this.ctx;
    c.save();
    c.fillStyle = color(o.color || 'black');
    c.font = `${o.size ?? 17}px ${o.font || FONT}`;
    c.textAlign = o.align || 'left';
    c.textBaseline = o.baseline || 'middle';
    c.fillText(String(str), this.X(x) + (o.offset?.[0] ?? 0), this.Y(y) + (o.offset?.[1] ?? 0));
    c.restore();
    return this;
  }

  /**
   * 数式を含むラベル（"$\tau$ = 1.0" など）。HTML で重ねる。
   * o: { anchor:'c'|'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw', color, size, offset:[dx,dy] }
   */
  label(x, y, str, o = {}) {
    let el = this._labels[this._used];
    if (!el) {
      el = h('div', { class: 'lw-plot-label' });
      this.overlay.appendChild(el);
      this._labels.push(el);
    }
    this._used++;
    const text = String(str);
    if (el._text !== text) {
      el.innerHTML = this.w.env.renderer.inline(text);
      el._text = text;
    }
    const [tx, ty, dx, dy] = ANCHORS[o.anchor || 'ne'] || ANCHORS.ne;
    el.style.left = this.X(x) + dx + (o.offset?.[0] ?? 0) + 'px';
    el.style.top = this.Y(y) + dy + (o.offset?.[1] ?? 0) + 'px';
    el.style.transform = `translate(${tx}%, ${ty}%)`;
    el.style.color = o.color ? color(o.color) : '';
    el.style.fontSize = o.size ? o.size + 'px' : '';
    el.style.display = '';
    return this;
  }

  /**
   * ドラッグできる点（render の外で 1 回だけ作る）
   * o: { x, y, color, radius, label: 文字列 or (h)=>文字列, constrain:(x,y)=>[x,y], snap }
   * 戻り値の .x / .y（複素平面なら .z = {re, im}）を render 内で参照する。
   */
  handle(o = {}) {
    const hd = new Handle(this, o);
    this._handles.push(hd);
    this.w._params.push(hd);     // 位置を保存・復元する
    this.canvas.style.touchAction = 'none';
    this.el.classList.add('lw-has-handles');
    return hd;
  }

  _drawHandles() {
    const c = this.ctx;
    for (const hd of this._handles) {
      const X = this.X(hd.x), Y = this.Y(hd.y);
      c.save();
      if (hd.dragging) {
        c.globalAlpha = 0.22;
        c.fillStyle = hd.color;
        c.beginPath();
        c.arc(X, Y, hd.radius + 10, 0, Math.PI * 2);
        c.fill();
        c.globalAlpha = 1;
      }
      c.beginPath();
      c.arc(X, Y, hd.radius, 0, Math.PI * 2);
      c.fillStyle = hd.color;
      c.fill();
      c.lineWidth = 2.5;
      c.strokeStyle = '#ffffff';
      c.stroke();
      c.restore();
      const lab = typeof hd.label === 'function' ? hd.label(hd) : hd.label;
      if (lab) this.label(hd.x, hd.y, lab, { anchor: hd.anchor || 'ne', color: hd.color, offset: [4, -4] });
    }
  }

  _drawLegend() {
    const pos = this.o.legend ?? 'ne';
    const items = pos === false ? [] : this._legend;
    const key = items.map((i) => `${i.label}\u0001${i.color}\u0001${i.dash}\u0001${i.kind}`).join('\u0002');
    if (key === this._legendKey) return;
    this._legendKey = key;
    if (this._legendEl) { this._legendEl.remove(); this._legendEl = null; }
    if (!items.length) return;
    const el = h('div', { class: `lw-plot-legend lw-legend-${pos}` });
    for (const it of items) {
      const sw = h('span', { class: `lw-legend-swatch lw-legend-${it.kind}` });
      sw.style.setProperty('--c', it.color);
      if (it.dash) sw.classList.add('dash');
      el.appendChild(h('div', { class: 'lw-legend-row' }, sw, h('span', { html: this.w.env.renderer.inline(it.label) })));
    }
    const { x, y, w, h: hh } = this.box;
    el.style.left = (pos.includes('w') ? x + 8 : x + w - 8) + 'px';
    el.style.top = (pos.includes('s') ? y + hh - 8 : y + 8) + 'px';
    el.style.transform = `translate(${pos.includes('w') ? 0 : -100}%, ${pos.includes('s') ? -100 : 0}%)`;
    this.overlay.appendChild(el);
  }

  // ---- 点のドラッグ ----
  _initPointer() {
    const cv = this.canvas;
    // InkInput から参照：この位置ならペンでも手書きせずドラッグを優先
    cv.lwWantsPointer = (e) => !!this._hit(e);
    cv.addEventListener('pointerdown', (e) => {
      const hd = this._hit(e);
      if (!hd) return;
      e.preventDefault();
      e.stopPropagation();
      try { cv.setPointerCapture(e.pointerId); } catch { /* */ }
      const p = this._px(e);
      this._drag = { id: e.pointerId, hd, dx: this.X(hd.x) - p.x, dy: this.Y(hd.y) - p.y };
      hd.dragging = true;
      this.w.invalidate();
    });
    cv.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      const p = this._px(e);
      d.hd.set(this.invX(p.x + d.dx), this.invY(p.y + d.dy));
    });
    const end = (e) => {
      const d = this._drag;
      if (!d || e.pointerId !== d.id) return;
      d.hd.dragging = false;
      this._drag = null;
      this.w.invalidate();
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  _px(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * this.width) / r.width, y: ((e.clientY - r.top) * this.height) / r.height };
  }

  _hit(e) {
    if (!this._handles.length) return null;
    const p = this._px(e);
    const R = e.pointerType === 'touch' ? 30 : 18;
    let best = null;
    let bd = R * R;
    for (const hd of this._handles) {
      const dx = this.X(hd.x) - p.x, dy = this.Y(hd.y) - p.y;
      const d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = hd; }
    }
    return best;
  }
}

class Handle {
  constructor(plot, o) {
    this.plot = plot;
    this.x = o.x ?? 0;
    this.y = o.y ?? 0;
    this.color = color(o.color || 'red');
    this.radius = o.radius ?? 9;
    this.label = o.label ?? null;
    this.anchor = o.anchor;
    this.constrain = o.constrain;
    this.snap = o.snap ?? 0;
    this.dragging = false;
    this._fns = [];
  }
  set(x, y) {
    if (this.constrain) {
      const r = this.constrain(x, y);
      if (Array.isArray(r)) [x, y] = r;
      else if (r && typeof r === 'object') ({ x, y } = r);
    }
    if (this.snap) {
      x = Math.round(x / this.snap) * this.snap;
      y = Math.round(y / this.snap) * this.snap;
    }
    const p = this.plot;
    x = Number(clamp(x, p.vx[0], p.vx[1]).toFixed(10));
    y = Number(clamp(y, p.vy[0], p.vy[1]).toFixed(10));
    if (x === this.x && y === this.y) return;
    this.x = x;
    this.y = y;
    for (const fn of this._fns) fn(this);
    p.w.invalidate();
  }
  onChange(fn) { this._fns.push(fn); return this; }
  /** [x, y]（値の保存・復元用） */
  get value() { return [this.x, this.y]; }
  set value(v) { if (Array.isArray(v) && v.length === 2) this.set(Number(v[0]), Number(v[1])); }
  /** 複素平面上の値 { re, im } */
  get z() { return { re: this.x, im: this.y }; }
}

function arrowHead(c, x, y, ang, size) {
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x - size * Math.cos(ang - 0.38), y - size * Math.sin(ang - 0.38));
  c.lineTo(x - size * Math.cos(ang + 0.38), y - size * Math.sin(ang + 0.38));
  c.closePath();
  c.fill();
}
