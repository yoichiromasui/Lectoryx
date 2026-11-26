// =============================================================
// 授業モードのページ送りボタン（左下の小さな ‹ ›）
//   ツールバーを隠しているとき（設定 compact）、設定 pageButtons が ON なら表示する。
//   右手で書くときに手のひらが乗りやすい右下を避けて左下に置く。
//   誤動作を防ぐため、次のときだけ反応する：
//     ・短いタップ（押してから 0.6 秒以内に離す）で、押した位置からほとんど動かしていない
//     ・指の場合：接触が小さい（手のひらでない）、ペンで書いている最中・直後でない
// =============================================================
import { h } from '../util.js';
import { ICONS } from './icons.js';
import { PALM_RADIUS, TOOLBAR_PALM_GUARD_MS } from '../config.js';
import { diag } from '../diag.js';

const TAP_MS = 600;
const TAP_MOVE = 12;

export class PageButtons {
  constructor({ root, view, settings }) {
    this.view = view;
    this.settings = settings;
    this.prevBtn = this._button('prev', '前のページ', () => view.prev());
    this.nextBtn = this._button('next', '次のページ', () => view.next());
    this.el = h('div', { class: 'lw-pagebtns' }, this.prevBtn, this.nextBtn);
    root.appendChild(this.el);
    settings.on('change', (k) => { if (k === 'compact' || k === 'pageButtons') this.sync(); });
    view.on('page', () => this.sync());
    this.sync();
  }

  _button(icon, title, fn) {
    const b = h('button', { type: 'button', class: 'lw-pagebtn', title, 'aria-label': title, html: ICONS[icon] });
    let down = null;
    b.addEventListener('pointerdown', (e) => {
      down = null;
      if (e.pointerType === 'touch') {
        const big = Math.max(e.width || 0, e.height || 0) > PALM_RADIUS * 2;
        if (big || this.view.input.penGuard(performance.now(), TOOLBAR_PALM_GUARD_MS)) {
          diag('palm', `ページ送りボタンのタッチを無視（${big ? '接触が大きい' : 'ペンの直後'}）`, 1000);
          return;
        }
      }
      down = { id: e.pointerId, t: performance.now(), x: e.clientX, y: e.clientY };
      try { b.setPointerCapture(e.pointerId); } catch { /* 合成イベント等 */ }
    });
    b.addEventListener('pointermove', (e) => {
      if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_MOVE) down = null;
    });
    b.addEventListener('pointerup', (e) => {
      if (!down || e.pointerId !== down.id) return;
      const ok = performance.now() - down.t < TAP_MS && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= TAP_MOVE;
      down = null;
      if (ok && !b.disabled) fn();
    });
    b.addEventListener('pointercancel', () => { down = null; });
    return b;
  }

  sync() {
    const on = this.settings.get('compact') && this.settings.get('pageButtons');
    document.body.classList.toggle('lw-pagebtns-on', !!on);
    this.prevBtn.disabled = this.view.index <= 0;
    this.nextBtn.disabled = this.view.index >= this.view.book.length - 1;
  }
}
