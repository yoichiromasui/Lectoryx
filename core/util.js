// 小さな共通ユーティリティ（DOM 生成・イベント・数値）

/**
 * 要素生成ヘルパ
 *   h('div', { class: 'a', onclick: fn, dataset: { x: 1 } }, child, 'text')
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function uid() {
  return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** シンプルなイベントエミッタ */
export class Emitter {
  constructor() { this._handlers = new Map(); }
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this._handlers.get(type)?.delete(fn); }
  emit(type, ...args) {
    for (const fn of this._handlers.get(type) ?? []) {
      try { fn(...args); } catch (e) { console.error(e); }
    }
  }
}

/** rAF で 1 フレームに 1 回だけ実行する関数を作る */
export function rafThrottle(fn) {
  let id = 0;
  const wrapped = () => {
    if (id) return;
    id = requestAnimationFrame(() => { id = 0; fn(); });
  };
  wrapped.cancel = () => { if (id) cancelAnimationFrame(id); id = 0; };
  return wrapped;
}

/** 矩形 {x0,y0,x1,y1} の操作 */
export const rect = {
  union(a, b) {
    if (!a) return b ? { ...b } : null;
    if (!b) return { ...a };
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
  },
  intersects(a, b) {
    return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
  },
  intersect(a, b) {
    const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
    return r.x0 < r.x1 && r.y0 < r.y1 ? r : null;
  },
  pad(a, d) { return { x0: a.x0 - d, y0: a.y0 - d, x1: a.x1 + d, y1: a.y1 + d }; },
};

/** iPad / iPhone 判定（iPadOS はデスクトップ UA を名乗るため maxTouchPoints も見る） */
export function isAppleTouchDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** ホーム画面から起動された Web アプリか */
export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: fullscreen)').matches ||
    navigator.standalone === true;
}
