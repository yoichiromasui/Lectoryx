// =============================================================
// ウィジェット（講義ごとの widgets.js から使う API）
//
//   export function stepResponse(w) {
//     const T = w.slider({ label: '$T$', min: 0.2, max: 5, step: 0.1, value: 1, unit: 's' });
//     const p = w.plot({ x: [0, 10], y: [0, 1.2], xlabel: '$t$ [s]', ylabel: '$y(t)$' });
//     w.render(() => {
//       p.fn((t) => 1 - Math.exp(-t / T.value), { label: '$y(t)$' });
//     });
//   }
//
// ・操作部品（slider/number/checkbox/select/button/animation）は .lw-controls に、
//   表示部品（plot/canvas/output）は .lw-display に作成順で並ぶ。
// ・値が変わると render() に登録した関数が次のフレームでまとめて実行される。
//   plot/canvas は render の直前に自動で消去・軸の再描画が行われる。
// ・ページの外に出るとアニメーションは自動停止する。
// ・操作部品（slider/number/checkbox/select）とグラフのドラッグ点の値は、ページごとに
//   自動保存され、次に開いたときに復元される（作成順で対応付ける）。
// =============================================================
import { h } from '../util.js';
import { Plot, Surface, PALETTE, color } from './plot.js';
import * as numeric from './numeric.js';
import { diag } from '../diag.js';
import { Slider, NumberInput, Toggle, Select, Animation, makeButton } from './controls.js';

export class Widget {
  constructor(el, opts, env) {
    this.el = el;
    this.opts = opts;
    this.env = env;
    this.math = numeric;
    this.colors = PALETTE;
    this.color = color;
    el.textContent = '';
    this.controlsEl = h('div', { class: 'lw-controls', 'data-ink': 'off' });
    this.displayEl = h('div', { class: 'lw-display' });
    this.setLayout(opts.layout || 'top');
    this._renderers = [];
    this._surfaces = [];
    this._anims = [];
    this._showFns = [];
    this._hideFns = [];
    this._frame = 0;
    this._started = false;
    this._visible = false;
    this._scale = 0;
    this._errorEl = null;
    this._params = [];      // 保存・復元する値（.value と .onChange を持つもの）
    this._resetParams = null;
  }

  /** 'top'（操作部が上）| 'bottom'（下）| 'side'（右） */
  setLayout(name) {
    this.layout = name;
    this.el.className = `lw-widget lw-widget-${name}`;
    if (name === 'bottom' || name === 'side') this.el.append(this.displayEl, this.controlsEl);
    else this.el.append(this.controlsEl, this.displayEl);
    return this;
  }

  // ---- 操作部品 ----
  slider(o = {}) { return this._control(new Slider(o, this)); }
  number(o = {}) { return this._control(new NumberInput(o, this)); }
  checkbox(o = {}) { return this._control(new Toggle(o, this)); }
  select(o = {}) { return this._control(new Select(o, this)); }
  button(label, fn) {
    const b = makeButton(label, fn, this);
    this.controlsEl.appendChild(b);
    return b;
  }
  animation(o = {}) {
    const a = new Animation(o, this);
    this._anims.push(a);
    this.controlsEl.appendChild(a.el);
    return a;
  }
  /** 操作部の改行 */
  br() {
    this.controlsEl.appendChild(h('div', { class: 'lw-ctl-break' }));
    return this;
  }
  _control(c) {
    this.controlsEl.appendChild(c.el);
    this._params.push(c);
    return c;
  }

  /**
   * 保存した値を復元し、以後の変更を保存する（mountWidgets から部品の作成後・初回描画前に呼ぶ）
   * state = { get(key) → 値の配列|null, set(key, 値の配列|null) }
   */
  _bindParams(state, key) {
    const saved = state.get(key);
    this._params.forEach((p, i) => {
      p._lwInitial = p.value;
      if (saved && i < saved.length && saved[i] != null) {
        try { p.value = saved[i]; } catch (e) { console.warn('保存した値を復元できません', e); }
      }
    });
    if (!this._params.length) return;
    const save = () => state.set(key, this._params.map((p) => p.value));
    for (const p of this._params) p.onChange(save);
    this._resetParams = () => {
      for (const p of this._params) p.value = p._lwInitial;
      state.set(key, null);
    };
  }

  // ---- 表示部品 ----
  plot(o = {}) {
    const p = new Plot(o, this);
    this.displayEl.appendChild(p.el);
    this._surfaces.push(p);
    if (this._started) { p.resize(); this.invalidate(); }
    return p;
  }
  canvas(o = {}) {
    const s = new Surface(o, this);
    this.displayEl.appendChild(s.el);
    this._surfaces.push(s);
    if (this._started) { s.resize(); this.invalidate(); }
    return s;
  }
  /** 文字・数式の出力欄。.tex(src) / .md(text) / .text(str) / .html(html) で更新 */
  output(o = {}) {
    const out = new Output(o, this);
    (o.in === 'controls' ? this.controlsEl : this.displayEl).appendChild(out.el);
    return out;
  }

  // ---- 再描画 ----
  render(fn) {
    this._renderers.push(fn);
    if (this._started) this.invalidate();
    return this;
  }
  invalidate() {
    if (this._frame || !this._started) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._run();
    });
  }
  _run() {
    const t0 = performance.now();
    this._runInner();
    const ms = performance.now() - t0;
    if (ms > 60) diag('widget', `${this.el.dataset.widget || 'ウィジェット'} ${Math.round(ms)}ms`, 3000);
  }
  _runInner() {
    for (const s of this._surfaces) s._begin();
    for (const fn of this._renderers) {
      try {
        fn();
      } catch (e) {
        console.error(e);
        this._error(e);
      }
    }
    for (const s of this._surfaces) s._end();
  }
  _error(e) {
    if (!this._errorEl) {
      this._errorEl = h('div', { class: 'lw-error' });
      this.el.appendChild(this._errorEl);
    }
    this._errorEl.textContent = `描画エラー: ${e.message}`;
  }

  // ---- ライフサイクル（PageView から呼ばれる） ----
  onShow(fn) { this._showFns.push(fn); return this; }
  onHide(fn) { this._hideFns.push(fn); return this; }
  get visible() { return this._visible; }

  _start() {
    this._started = true;
    this._scale = this.env.scale;
    for (const s of this._surfaces) s.resize();
    this._run(); // 初回は同期的に描画してレイアウトを確定させる
  }
  show() {
    this._visible = true;
    if (this._scale !== this.env.scale) this.resize();
    for (const fn of this._showFns) fn();
    for (const a of this._anims) if (a.autoplay) a.play();
  }
  hide() {
    this._visible = false;
    for (const a of this._anims) a.pause();
    for (const fn of this._hideFns) fn();
  }
  resize() {
    this._scale = this.env.scale;
    for (const s of this._surfaces) s.resize();
    if (this._started) this._run();
  }
}

class Output {
  constructor(o, w) {
    this.w = w;
    this.display = !!o.display;
    this.el = h('div', { class: 'lw-output' + (o.class ? ' ' + o.class : '') });
    if (o.height) this.el.style.height = o.height + 'px';
    if (o.width) this.el.style.width = o.width + 'px';
    if (o.align) this.el.style.textAlign = o.align;
    this._key = null;
  }
  _set(key, fn) {
    if (key === this._key) return this;
    this._key = key;
    this.el.innerHTML = fn();
    return this;
  }
  tex(src) { return this._set('t' + src, () => this.w.env.renderer.tex(String(src), this.display)); }
  md(src) { return this._set('m' + src, () => this.w.env.renderer.inline(String(src))); }
  text(str) { return this._set('s' + str, () => String(str).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))); }
  html(str) { return this._set('h' + str, () => String(str)); }
}
