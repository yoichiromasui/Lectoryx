// =============================================================
// 入力の振り分け（Apple Pencil / 指 / マウス）
//
// ・ペン（pointerType 'pen'）      → 手書き（ツールが hand 以外のとき）
// ・指（pointerType 'touch'）      → ネイティブのスクロール・教材の操作に任せる
// ・マウス                         → 手書き（PC での準備・確認用）
//
// iPad Safari では Pointer Events の preventDefault ではスクロールを止められないため、
// touchstart/touchmove（passive:false）で Touch.touchType === 'stylus' のタッチだけ
// preventDefault してペンによるスクロール・選択・ルーペを抑止する。
// pointerdown はキャプチャ段階で受け取り stopPropagation するので、
// ペンで書いている間は下の教材（スライダー等）にイベントが届かない。
//
// パームリジェクション：
//   ペン接触中と、ペンを離してから PALM_GUARD_MS の間は指タッチを無効化。
//   直近にペンを使っていた場合は、接触半径の大きいタッチも手のひらとみなす。
//
// [data-ink="off"] の要素（ウィジェットの操作パネル等）の上ではペンも通常操作になる。
// 要素に lwWantsPointer(e) 関数があり true を返す場合も通常操作（グラフ上の点のドラッグ）。
// =============================================================
import { PALM_GUARD_MS, PALM_RADIUS, PALM_RECENT_MS, PAGE_WIDTH } from '../config.js';
import { diag } from '../diag.js';

const INK_TOOLS = new Set(['pen', 'hl', 'eraser', 'laser', 'text']);

function noInk(target, x, y, pointerType) {
  if (!target || !target.closest) return false;
  if (target.closest('[data-ink="off"], .lw-error')) return true;
  if (typeof target.lwWantsPointer === 'function') {
    try { return !!target.lwWantsPointer({ clientX: x, clientY: y, pointerType }); } catch { return false; }
  }
  return false;
}

export class InkInput {
  constructor({ el, scroller, settings, controller }) {
    this.el = el;
    this.scroller = scroller;
    this.settings = settings;
    this.controller = controller;
    this.active = null;        // { id, type }
    this.lastPenUp = -1e9;
    this.lastPenDown = -1e9;
    this.lastScroll = -1e9;
    this.inkTouches = new Set();
    this.blockedTouches = new Set();
    this.rect = null;

    const on = (type, fn, opts) => el.addEventListener(type, fn.bind(this), opts);
    on('pointerdown', this.onDown, { capture: true });
    on('pointermove', this.onMove);
    on('pointerup', this.onUp);
    on('pointercancel', this.onUp);
    on('lostpointercapture', this.onLost);
    on('pointerleave', this.onLeave);
    on('touchstart', this.onTouchStart, { passive: false });
    on('touchmove', this.onTouchMove, { passive: false });
    on('touchend', this.onTouchEnd);
    on('touchcancel', this.onTouchEnd);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('dragstart', (e) => e.preventDefault());
    scroller.addEventListener('scroll', () => {
      this.lastScroll = performance.now();
      if (this.active) this.rect = this.el.getBoundingClientRect();
    }, { passive: true });
  }

  get inkTool() { return INK_TOOLS.has(this.settings.get('tool')); }

  /** ペンで書いている最中、または書いた直後（ms 以内）か */
  penGuard(now = performance.now(), ms = PALM_GUARD_MS) {
    return (this.active && this.active.type === 'pen') || now - this.lastPenUp < ms;
  }

  wantsInk(e) {
    if (!this.inkTool) return false;
    if (noInk(e.target, e.clientX, e.clientY, e.pointerType)) return false;
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.button === 0;
    if (e.pointerType === 'touch') return this.settings.get('fingerDraw') && e.isPrimary;
    return false;
  }

  toPoint(e) {
    const r = this.rect;
    const s = r.width / PAGE_WIDTH;
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s, p: e.pressure, type: e.pointerType };
  }

  onDown(e) {
    const now = performance.now();
    if (this.active) {
      if (e.pointerId !== this.active.id) { e.stopPropagation(); e.preventDefault(); }
      return;
    }
    if (e.pointerType === 'touch' && !this.settings.get('fingerDraw') && this.penGuard(now)) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (!this.wantsInk(e)) return;
    e.stopPropagation();
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* 合成イベント等 */ }
    if (now - this.lastScroll < 150) this.stopMomentum();
    this.rect = this.el.getBoundingClientRect();
    if (this.controller.begin(this.toPoint(e))) {
      this.active = { id: e.pointerId, type: e.pointerType };
      if (e.pointerType === 'pen') this.lastPenDown = now;
    }
  }

  onMove(e) {
    if (this.active) {
      if (e.pointerId !== this.active.id) return;
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      const evs = list && list.length ? list : [e];
      this.controller.move(evs.map((ev) => this.toPoint(ev)));
      return;
    }
    if (e.pointerType === 'pen' && e.buttons === 0 && this.settings.get('tool') === 'eraser') {
      this.rect = this.el.getBoundingClientRect();
      this.controller.hover(this.toPoint(e));
    }
  }

  onUp(e) {
    if (this.active && e.pointerId === this.active.id) this.finish();
  }

  onLost(e) {
    if (this.active && e.pointerId === this.active.id) this.finish();
  }

  onLeave(e) {
    if (!this.active && e.pointerType === 'pen') this.controller.hoverEnd();
  }

  /** 入力中のストロークを確定する（ページ移動時などにも呼ぶ） */
  finish() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.controller.end();
    if (a.type === 'pen') this.lastPenUp = performance.now();
    try { this.el.releasePointerCapture(a.id); } catch { /* 既に解放済み */ }
  }

  onTouchStart(e) {
    const now = performance.now();
    let prevent = false;
    for (const t of e.changedTouches) {
      if (t.touchType === 'stylus') {
        if (this.inkTool && !noInk(t.target, t.clientX, t.clientY, 'pen')) {
          this.inkTouches.add(t.identifier);
          prevent = true;
        }
        continue;
      }
      if (this.settings.get('fingerDraw')) {
        if (this.inkTool && !noInk(t.target, t.clientX, t.clientY, 'touch')) {
          this.inkTouches.add(t.identifier);
          prevent = true;
        }
        continue;
      }
      const radius = Math.max(t.radiusX || 0, t.radiusY || 0);
      const palm = radius > PALM_RADIUS && now - Math.max(this.lastPenUp, this.lastPenDown) < PALM_RECENT_MS;
      const guard = this.penGuard(now);
      if (palm || guard) {
        this.blockedTouches.add(t.identifier);
        prevent = true;
        diag('palm', `指のタッチを無視（${guard ? 'ペンの直後' : '接触が大きい'}・半径 ${Math.round(radius)}）`, 2000);
      }
    }
    if (prevent && e.cancelable) e.preventDefault();
  }

  onTouchMove(e) {
    if (!e.cancelable) return;
    for (const t of e.touches) {
      if (this.inkTouches.has(t.identifier) || this.blockedTouches.has(t.identifier)) {
        e.preventDefault();
        return;
      }
    }
    if (this.active) e.preventDefault();
  }

  onTouchEnd(e) {
    for (const t of e.changedTouches) {
      this.inkTouches.delete(t.identifier);
      this.blockedTouches.delete(t.identifier);
    }
  }

  /** 慣性スクロール中にペンが触れたらスクロールを止める（iOS） */
  stopMomentum() {
    const s = this.scroller;
    const top = s.scrollTop;
    const left = s.scrollLeft;   // 拡大中は横にも慣性スクロールする
    s.style.overflowY = 'hidden';
    s.style.overflowX = 'hidden';
    s.scrollTop = top;
    s.scrollLeft = left;
    requestAnimationFrame(() => { s.style.overflowY = ''; s.style.overflowX = ''; });
  }
}
