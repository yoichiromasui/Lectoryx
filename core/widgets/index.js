// 教材 HTML 中の <div class="lw-widget" data-widget="name"> を widgets.js の関数で初期化する
import { Widget } from './widget.js';
import { escapeHtml } from '../util.js';

function showError(el, msg) {
  el.className = 'lw-widget lw-widget-error';
  el.innerHTML = `<div class="lw-error">${escapeHtml(msg)}</div>`;
}

/**
 * @param {Element} root     ページの教材要素
 * @param {object} registry  widgets.js のモジュール（名前 → 関数）
 * @param {object} env       { scale, dpr, renderer, lectureBase }
 * @param {object} [state]   値の保存先 { get(key), set(key, values) }（key = "ページ内の番号:名前"）
 * @returns {Widget[]}
 */
export function mountWidgets(root, registry, env, state = null) {
  const list = [];
  let index = 0;
  for (const el of root.querySelectorAll('.lw-widget[data-widget]')) {
    const name = el.dataset.widget;
    const key = `${index++}:${name}`;
    let opts = {};
    try { opts = JSON.parse(el.dataset.opts || '{}'); } catch { /* 無視 */ }
    if (registry.__error) {
      showError(el, `widgets.js の読み込みに失敗しました: ${registry.__error.message}`);
      continue;
    }
    const factory = registry[name];
    if (typeof factory !== 'function') {
      showError(el, `ウィジェット "${name}" が widgets.js に見つかりません（export function ${name}(w) {...} を定義してください）`);
      continue;
    }
    const w = new Widget(el, opts, env);
    try {
      factory(w, opts);
      if (state) w._bindParams(state, key);
      w._start();
      list.push(w);
    } catch (e) {
      console.error(e);
      showError(el, `ウィジェット "${name}" の初期化でエラー: ${e.message}`);
    }
  }
  return list;
}
