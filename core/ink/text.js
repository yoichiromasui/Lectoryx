// =============================================================
// テキストの書き込み（キーボード・Scribble で入力する文字。$...$ は数式）
//
//   Text = { id, x, y, v:文字列, c:'#rrggbb', s:文字サイズ(論理px) }   // x, y は左上の論理座標
//   PageRecord.texts に保存する（ストロークとは別の配列。Stroke の形式は変えない）。
//
// 表示：.lw-text-layer（教材の上・蛍光ペンの下）に絶対配置の div。ページと一緒に拡大縮小。
// 操作（テキストツール）：
//   ・何もない所をタップ → その位置に入力欄。既存の文字をタップ → 編集。ドラッグ → 移動。
//   ・入力欄の外をタップ／Esc／ツール切替／ページ移動で確定。空にすると削除。
// Undo/Redo：op.texts = [{ i, a, b }]（a: 変更前, b: 変更後。null は「なし」。ink/history.js）
// =============================================================
import { h, uid, escapeHtml, clamp } from '../util.js';
import { PAGE_WIDTH } from '../config.js';
import { round1 } from './stroke.js';

export const TEXT_LINE_HEIGHT = 1.4;
const MOVE_THRESHOLD = 6;   // これ以上動いたらドラッグ（論理px）
const HIT_PAD = 8;          // タップ判定の余裕（論理px）

/** テキスト → HTML（$...$ は KaTeX、\$ は文字の $。それ以外はそのまま） */
export function textHtml(v, renderer) {
  let out = '';
  let buf = '';
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '\\' && v[i + 1] === '$') { buf += '$'; i++; continue; }
    if (ch === '$') {
      let j = i + 1;
      while (j < v.length && v[j] !== '$' && v[j] !== '\n') j += v[j] === '\\' ? 2 : 1;
      if (j < v.length && v[j] === '$' && j > i + 1) {
        out += escapeHtml(buf);
        buf = '';
        out += renderer ? renderer.tex(v.slice(i + 1, j)) : escapeHtml(v.slice(i, j + 1));
        i = j;
        continue;
      }
    }
    buf += ch;
  }
  return out + escapeHtml(buf);
}

function maxWidth(x) { return Math.max(80, PAGE_WIDTH - x - 8); }

/** 表示用の要素 */
function makeTextEl(t, renderer) {
  const el = h('div', { class: 'lw-text', html: textHtml(t.v, renderer) });
  el.dataset.id = t.id;
  el.style.left = t.x + 'px';
  el.style.top = t.y + 'px';
  el.style.color = t.c;
  el.style.fontSize = t.s + 'px';
  el.style.maxWidth = maxWidth(t.x) + 'px';
  return el;
}

/** テキストの層（PDF 出力用にも使う） */
export function renderTextLayer(texts, renderer) {
  const layer = h('div', { class: 'lw-text-layer' });
  for (const t of texts) layer.appendChild(makeTextEl(t, renderer));
  return layer;
}

/** 層の中の要素の最下端（論理px。DOM に配置済みであること） */
export function textLayerBottom(layer) {
  let b = 0;
  for (const el of layer.children) b = Math.max(b, el.offsetTop + el.offsetHeight);
  return b;
}

export function validText(t) {
  return !!t && typeof t.id === 'string' && typeof t.v === 'string' && typeof t.c === 'string' &&
    Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.s) && t.s > 0;
}

export class TextLayer {
  /** view: PageView（page, pageEl, lecture, settings, inkChanged(), layout()） */
  constructor(view) {
    this.view = view;
    this.el = h('div', { class: 'lw-text-layer' });
    view.pageEl.appendChild(this.el);
    this.items = new Map();   // id → 表示要素
    this.editor = null;       // { page, t, el, ta, mirror }
    this.gesture = null;
    view.settings.on('change', (k, v) => {
      if (k === 'tool' && v !== 'text') this.commit();
      if ((k === 'textColor' || k === 'textSize') && this.editor) {
        this.editor.t = { ...this.editor.t, [k === 'textColor' ? 'c' : 's']: v };
        this._style();
        this.editor.ta.focus({ preventScroll: true });
      }
    });
  }

  get renderer() { return this.view.lecture.renderer; }
  get editing() { return !!this.editor; }

  /** 現在のページのテキストを描き直す（編集中のものは入力欄で表示） */
  render() {
    const page = this.view.page;
    this.el.textContent = '';
    this.items.clear();
    if (!page) return;
    for (const t of page.state.texts) {
      if (this.editor && this.editor.t.id === t.id) continue;
      const el = makeTextEl(t, this.renderer);
      this.items.set(t.id, el);
      this.el.appendChild(el);
    }
    if (this.editor && this.editor.page === page) this.el.appendChild(this.editor.el);
  }

  /** 表示中のテキスト（入力欄を含む）の最下端 */
  bottom() {
    let b = textLayerBottom(this.el);
    if (this.editor) b = Math.max(b, this.editor.el.offsetTop + this.editor.ta.offsetHeight);
    return b;
  }

  /** (x, y) にあるテキスト */
  hit(x, y) {
    const texts = this.view.page?.state.texts || [];
    for (let i = texts.length - 1; i >= 0; i--) {
      const el = this.items.get(texts[i].id);
      if (!el) continue;
      if (x >= el.offsetLeft - HIT_PAD && x <= el.offsetLeft + el.offsetWidth + HIT_PAD &&
          y >= el.offsetTop - HIT_PAD && y <= el.offsetTop + el.offsetHeight + HIT_PAD) return texts[i];
    }
    return null;
  }

  // ---- テキストツールの入力（InkController から。pt は論理座標） ----
  begin(pt) {
    const wasEditing = this.editing;
    this.commit();
    const t = this.hit(pt.x, pt.y);
    this.gesture = { start: pt, t, el: t ? this.items.get(t.id) : null, wasEditing, dx: 0, dy: 0, moved: false };
  }

  move(pt) {
    const g = this.gesture;
    if (!g || !g.t) return;
    const dx = pt.x - g.start.x;
    const dy = pt.y - g.start.y;
    if (!g.moved && dx * dx + dy * dy < MOVE_THRESHOLD * MOVE_THRESHOLD) return;
    g.moved = true;
    g.dx = dx;
    g.dy = dy;
    g.el.style.transform = `translate(${dx}px, ${dy}px)`;
    g.el.classList.add('lw-dragging');
  }

  end() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    const page = this.view.page;
    if (g.moved) {
      const texts = page.state.texts;
      const k = texts.findIndex((x) => x.id === g.t.id);
      if (k >= 0) {
        const a = texts[k];
        const b = { ...a, x: round1(clamp(a.x + g.dx, -8, PAGE_WIDTH - 40)), y: round1(Math.max(0, a.y + g.dy)) };
        texts[k] = b;
        page.history.push({ removed: [], added: [], texts: [{ i: k, a, b }] });
        this.view.inkChanged(page);
      }
      this.render();
      this.view.layout();
      return;
    }
    if (g.t) this.open(g.t);
    else if (!g.wasEditing) this.open(null, g.start.x, g.start.y);   // 編集中に外をタップしたときは確定だけ
  }

  /** 入力欄を開く（t が null なら (x, y) に新規作成）。ペンを離したイベントの中で呼ぶ（iPad のキーボード表示のため） */
  open(t, x = 0, y = 0) {
    this.commit();
    const page = this.view.page;
    if (!page) return;
    if (!t) {
      const s = this.view.settings;
      const size = s.get('textSize');
      t = {
        id: uid(),
        x: round1(clamp(x - 4, 0, PAGE_WIDTH - 120)),
        y: round1(Math.max(0, y - size * TEXT_LINE_HEIGHT / 2)),
        v: '', c: s.get('textColor'), s: size,
      };
    }
    const ta = h('textarea', {
      class: 'lw-text-input', 'data-ink': 'off', rows: 1,
      spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'テキスト',
    });
    ta.value = t.v;
    const del = h('button', { type: 'button', class: 'lw-text-del', 'data-ink': 'off', title: 'このテキストを削除' }, '削除');
    del.addEventListener('pointerdown', (e) => e.preventDefault());   // 入力欄のフォーカスを外さない
    del.addEventListener('mousedown', (e) => e.preventDefault());
    del.addEventListener('click', () => this.removeEditing());
    const mirror = h('span', { class: 'lw-text-mirror', 'aria-hidden': 'true' });
    const el = h('div', { class: 'lw-text-editor', 'data-ink': 'off' }, ta, del, mirror);
    this.editor = { page, t, el, ta, mirror };
    this._style();
    ta.addEventListener('input', () => this._fit());
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;          // 日本語変換中
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.commit();
      }
    });
    ta.addEventListener('blur', () => { if (this.editor?.ta === ta) this.commit(); });
    this.render();
    this._fit();
    ta.focus({ preventScroll: true });
    const n = ta.value.length;
    try { ta.setSelectionRange(n, n); } catch { /* 古い環境 */ }
  }

  /** 編集中のテキストを削除（Undo で戻せる） */
  removeEditing() {
    if (!this.editor) return;
    this.editor.ta.value = '';
    this.commit();
  }

  /** 編集を確定する（変更があれば履歴に積む） */
  commit() {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    const v = ed.ta.value.replace(/\s+$/, '');
    ed.el.remove();
    const page = ed.page;
    const texts = page.state.texts;
    const k = texts.findIndex((x) => x.id === ed.t.id);
    const a = k >= 0 ? texts[k] : null;
    const b = v.trim() ? { ...ed.t, v } : null;
    const same = a && b && a.v === b.v && a.c === b.c && a.s === b.s && a.x === b.x && a.y === b.y;
    if (!same && (a || b)) {
      if (b && k >= 0) texts[k] = b;
      else if (b) texts.push(b);
      else texts.splice(k, 1);
      page.history.push({ removed: [], added: [], texts: [{ i: k >= 0 ? k : texts.length - 1, a, b }] });
      this.view.inkChanged(page);
    }
    if (page === this.view.page) {
      this.render();
      this.view.layout();
    }
  }

  _style() {
    const { t, el, ta, mirror } = this.editor;
    el.style.left = t.x + 'px';
    el.style.top = t.y + 'px';
    el.classList.toggle('lw-del-below', t.y < 48);
    for (const x of [ta, mirror]) {
      x.style.fontSize = t.s + 'px';
      x.style.color = t.c;
    }
    this._fit();
  }

  /** 入力欄の大きさを内容に合わせる（幅は最長の行、ページ右端で折り返す） */
  _fit() {
    const ed = this.editor;
    if (!ed) return;
    const { t, ta, mirror } = ed;
    mirror.textContent = ta.value + '​';
    const w = clamp(mirror.offsetWidth + t.s, t.s * 8, maxWidth(t.x));
    ta.style.width = w + 'px';
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    if (ed.page === this.view.page && ed.el.isConnected && t.y + ta.offsetHeight + 24 > this.view.H) this.view.layout();
  }
}
