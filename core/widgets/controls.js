// =============================================================
// ウィジェットの操作部品（スライダー・数値入力・チェック・選択・ボタン・アニメーション）
// すべて指・マウス・Apple Pencil で操作できる。値は .value で読み書きでき、
// 変更されると所属ウィジェットの再描画が予約される。
// =============================================================
import { h, clamp } from '../util.js';

function decimalsOf(step) {
  if (!(step > 0)) return 2;
  const d = Math.ceil(-Math.log10(step) - 1e-9);
  return clamp(d, 0, 6);
}

const minus = (s) => s.replace(/^-/, '−');

class Control {
  constructor(widget, value) {
    this.widget = widget;
    this._value = value;
    this._fns = [];
  }
  get value() { return this._value; }
  set value(v) { this.set(v); }
  set(v) {
    v = this._coerce(v);
    if (Object.is(v, this._value)) return;
    this._value = v;
    this._update();
    for (const fn of this._fns) fn(v);
    this.widget.invalidate();
  }
  onChange(fn) { this._fns.push(fn); return this; }
  _coerce(v) { return v; }
  _update() {}
  _label(text) {
    return h('span', { class: 'lw-ctl-label', html: this.widget.env.renderer.inline(text ?? '') });
  }
}

/** w.slider({ label, min, max, step, value, unit, format, width }) */
export class Slider extends Control {
  constructor(o, w) {
    const min = o.min ?? 0;
    const max = o.max ?? 1;
    super(w, o.value ?? min);
    this.min = min;
    this.max = max;
    this.step = o.step ?? (max - min) / 100;
    this.unit = o.unit ?? '';
    const dec = decimalsOf(this.step);
    this.format = o.format || ((v) => minus(v.toFixed(dec)));
    this.fill = h('div', { class: 'lw-slider-fill' });
    this.thumb = h('div', { class: 'lw-slider-thumb' });
    this.track = h('div', { class: 'lw-slider-track' }, h('div', { class: 'lw-slider-rail' }, this.fill), this.thumb);
    if (o.width) this.track.style.width = o.width + 'px';
    this.out = h('output', { class: 'lw-ctl-value' });
    this.el = h('div', { class: 'lw-ctl lw-slider' }, this._label(o.label), this.track, this.out);
    this._value = this._coerce(this._value);
    this.initial = this._value;
    this._update();

    let id = null;
    const fromEvent = (e) => {
      const r = this.track.getBoundingClientRect();
      const f = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
      this.set(this.min + f * (this.max - this.min));
    };
    this.track.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId;
      try { this.track.setPointerCapture(id); } catch { /* */ }
      this.el.classList.add('active');
      fromEvent(e);
      e.preventDefault();
    });
    this.track.addEventListener('pointermove', (e) => { if (e.pointerId === id) fromEvent(e); });
    const end = (e) => { if (e.pointerId === id) { id = null; this.el.classList.remove('active'); } };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
    // 値表示のダブルタップで初期値に戻す
    let lastTap = 0;
    this.out.addEventListener('pointerup', () => {
      const now = performance.now();
      if (now - lastTap < 350) this.set(this.initial);
      lastTap = now;
    });
  }
  _coerce(v) {
    v = clamp(Number(v), this.min, this.max);
    if (this.step > 0) v = this.min + Math.round((v - this.min) / this.step) * this.step;
    return Number(clamp(v, this.min, this.max).toFixed(10));
  }
  _update() {
    const f = this.max > this.min ? (this._value - this.min) / (this.max - this.min) : 0;
    this.fill.style.width = f * 100 + '%';
    this.thumb.style.left = f * 100 + '%';
    this.out.textContent = this.format(this._value) + (this.unit ? ' ' + this.unit : '');
  }
}

/** w.number({ label, value, step, min, max, unit }) ：−/＋ ボタン付き数値入力 */
export class NumberInput extends Control {
  constructor(o, w) {
    super(w, o.value ?? 0);
    this.min = o.min ?? -Infinity;
    this.max = o.max ?? Infinity;
    this.step = o.step ?? 1;
    this.dec = decimalsOf(this.step);
    this.input = h('input', { type: 'text', inputmode: 'decimal', class: 'lw-number-input', size: o.size ?? 6 });
    const dec = h('button', { type: 'button', class: 'lw-btn lw-btn-sm', onclick: () => this.set(this._value - this.step) }, '−');
    const inc = h('button', { type: 'button', class: 'lw-btn lw-btn-sm', onclick: () => this.set(this._value + this.step) }, '+');
    this.el = h('div', { class: 'lw-ctl lw-number' }, this._label(o.label), dec, this.input, inc,
      o.unit ? h('span', { class: 'lw-ctl-unit' }, o.unit) : null);
    this.input.addEventListener('change', () => {
      const v = parseFloat(this.input.value.replace('−', '-'));
      if (Number.isFinite(v)) this.set(v); else this._update();
    });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.input.blur(); e.stopPropagation(); });
    this._value = this._coerce(this._value);
    this._update();
  }
  _coerce(v) { return Number(clamp(Number(v), this.min, this.max).toFixed(10)); }
  _update() { this.input.value = minus(this._value.toFixed(this.dec)); }
}

/** w.checkbox({ label, value }) */
export class Toggle extends Control {
  constructor(o, w) {
    super(w, !!o.value);
    this.el = h('button', { type: 'button', class: 'lw-ctl lw-toggle', 'aria-pressed': 'false', onclick: () => this.set(!this._value) },
      h('span', { class: 'lw-toggle-box' }), this._label(o.label));
    this._update();
  }
  _coerce(v) { return !!v; }
  _update() { this.el.setAttribute('aria-pressed', String(this._value)); }
}

/**
 * w.select({ label, options, value })
 *   options: ['a','b'] / [{label:'A', value:1}, ...] / { 'A': 1, 'B': 2 }
 */
export class Select extends Control {
  constructor(o, w) {
    let opts = o.options || [];
    if (!Array.isArray(opts)) opts = Object.entries(opts).map(([label, value]) => ({ label, value }));
    opts = opts.map((x) => (x && typeof x === 'object' ? x : { label: String(x), value: x }));
    super(w, o.value ?? opts[0]?.value);
    this.options = opts;
    this.buttons = opts.map((x) => h('button', {
      type: 'button', class: 'lw-seg-btn', html: w.env.renderer.inline(x.label),
      onclick: () => this.set(x.value),
    }));
    this.el = h('div', { class: 'lw-ctl lw-select' }, this._label(o.label), h('div', { class: 'lw-seg' }, this.buttons));
    this._update();
  }
  _update() {
    this.options.forEach((x, i) => this.buttons[i].classList.toggle('on', Object.is(x.value, this._value)));
  }
}

/** w.button(label, onClick) */
export function makeButton(label, fn, w) {
  return h('button', {
    type: 'button', class: 'lw-ctl lw-btn', html: w.env.renderer.inline(label),
    onclick: () => { fn?.(); w.invalidate(); },
  });
}

/**
 * w.animation({ duration, loop, speed, autoplay, label, unit })
 *   .t（経過時間）/ .playing / play() / pause() / toggle() / reset()
 *   ページを離れると自動で一時停止する。
 */
export class Animation {
  constructor(o, w) {
    this.widget = w;
    this.t = 0;
    this.speed = o.speed ?? 1;
    this.duration = o.duration ?? Infinity;
    this.loop = !!o.loop;
    this.autoplay = !!o.autoplay;
    this.playing = false;
    this.unit = o.unit ?? 's';
    this._raf = 0;
    this._last = 0;
    this._fns = [];
    this.playBtn = h('button', { type: 'button', class: 'lw-btn lw-anim-play', onclick: () => this.toggle() });
    this.resetBtn = h('button', { type: 'button', class: 'lw-btn lw-anim-reset', title: 'リセット', onclick: () => this.reset() }, '⟲');
    this.out = h('output', { class: 'lw-ctl-value lw-anim-time' });
    this.el = h('div', { class: 'lw-ctl lw-anim' },
      o.label ? h('span', { class: 'lw-ctl-label', html: w.env.renderer.inline(o.label) }) : null,
      this.playBtn, this.resetBtn, o.showTime === false ? null : this.out);
    this._update();
  }
  onFrame(fn) { this._fns.push(fn); return this; }
  play() {
    if (this.playing) return;
    if (this.t >= this.duration && !this.loop) this.t = 0;
    this.playing = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame((now) => this._tick(now));
    this._update();
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this._raf);
    this._update();
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  reset() {
    this.t = 0;
    this._update();
    this.widget.invalidate();
  }
  _tick(now) {
    if (!this.playing) return;
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    this.t += dt * this.speed;
    if (this.t >= this.duration) {
      if (this.loop) this.t %= this.duration;
      else { this.t = this.duration; this.pause(); }
    }
    for (const fn of this._fns) fn(this.t, dt);
    this._update();
    this.widget.invalidate();
    if (this.playing) this._raf = requestAnimationFrame((n) => this._tick(n));
  }
  _update() {
    this.playBtn.textContent = this.playing ? '⏸' : '▶';
    this.playBtn.classList.toggle('on', this.playing);
    this.out.textContent = `t = ${this.t.toFixed(1)} ${this.unit}`;
  }
}
