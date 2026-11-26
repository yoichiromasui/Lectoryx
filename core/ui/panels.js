// ページ一覧・メニュー・トースト
import { h, isStandalone } from '../util.js';
import { ICONS } from './icons.js';
import { BACKGROUNDS } from '../config.js';

// ---------------------------------------------------------------
// トースト（画面下の短い通知）
// ---------------------------------------------------------------
let toastEl = null;
let toastTimer = 0;
export function toast(msg, ms = 2200) {
  if (!toastEl) {
    toastEl = h('div', { class: 'lw-toast', role: 'status' });
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ---------------------------------------------------------------
// ページ一覧
// ---------------------------------------------------------------
export class Overview {
  constructor({ root, view, book, lecture }) {
    this.view = view;
    this.book = book;
    this.lecture = lecture;
    this.grid = h('div', { class: 'lw-ov-grid' });
    const title = lecture.meta.title || lecture.id;
    const sub = [lecture.meta.course, lecture.meta.lecture, lecture.meta.date].filter(Boolean).join(' / ');
    this.el = h('div', { class: 'lw-overlay lw-overview', hidden: true },
      h('div', { class: 'lw-ov-head' },
        h('div', { class: 'lw-ov-title' },
          h('div', { html: lecture.renderer.inline(title) }),
          sub ? h('div', { class: 'lw-ov-sub' }, sub) : null),
        h('button', { type: 'button', class: 'lw-tb-btn', title: '閉じる', html: ICONS.close, onclick: () => this.close() })),
      this.grid);
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });
    root.appendChild(this.el);
  }
  get isOpen() { return !this.el.hidden; }
  toggle() { this.isOpen ? this.close() : this.open(); }
  close() { this.el.hidden = true; }
  open() {
    const g = this.grid;
    g.textContent = '';
    this.book.pages.forEach((p, i) => {
      const n = p.state.strokes.length + p.state.texts.length;
      const card = h('button', { type: 'button', class: 'lw-ov-card' + (i === this.view.index ? ' current' : '') + (p.kind === 'blank' ? ' blank' : ''),
        onclick: () => { this.close(); this.view.show(i); } },
      h('div', { class: 'lw-ov-num' }, String(i + 1)),
      h('div', { class: 'lw-ov-name', html: p.kind === 'blank' ? '白紙' : this.lecture.renderer.inline(this.book.title(p)) }),
      h('div', { class: 'lw-ov-meta' }, n ? `✎ ${n}` : ''));
      if (p.kind === 'blank') {
        const del = h('span', { class: 'lw-ov-del', role: 'button', title: 'この白紙ページを削除', html: ICONS.close });
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          if (n && !confirm(`白紙ページ ${i + 1} には書き込みがあります。削除しますか？`)) return;
          this.view.deletePage(i);
          this.open();
        });
        card.appendChild(del);
      }
      g.appendChild(card);
    });
    this.el.hidden = false;
    g.querySelector('.current')?.scrollIntoView({ block: 'center' });
  }
}

// ---------------------------------------------------------------
// メニュー（⋯）
// ---------------------------------------------------------------
const BG_LABELS = { none: '無地', grid: '方眼', lines: '罫線', dots: 'ドット' };

export class Menu {
  /** actions: { exportPdf(), exportInk(), importInk(), home(), clear() } */
  constructor({ root, view, settings, actions }) {
    this.view = view;
    this.settings = settings;
    this.actions = actions;
    this.panel = h('div', { class: 'lw-menu' });
    this.el = h('div', { class: 'lw-overlay lw-menu-wrap', hidden: true }, this.panel);
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });
    root.appendChild(this.el);
  }
  get isOpen() { return !this.el.hidden; }
  close() { this.el.hidden = true; }
  open(anchor) {
    const p = this.panel;
    const s = this.settings;
    const v = this.view;
    p.textContent = '';
    const item = (label, fn, opts = {}) => h('button', {
      type: 'button', class: 'lw-menu-item' + (opts.danger ? ' danger' : ''), disabled: opts.disabled,
      onclick: () => { this.close(); fn(); },
    }, label);
    const toggle = (label, key) => {
      const b = h('button', { type: 'button', class: 'lw-menu-item lw-menu-toggle', 'aria-pressed': String(s.get(key)),
        onclick: () => { s.toggle(key); b.setAttribute('aria-pressed', String(s.get(key))); } },
      h('span', {}, label), h('span', { class: 'lw-switch' }));
      return b;
    };
    const bgSeg = h('div', { class: 'lw-seg' }, BACKGROUNDS.map((bg) => h('button', {
      type: 'button', class: 'lw-seg-btn' + (v.background === bg ? ' on' : ''),
      onclick: (e) => {
        v.setBackground(bg);
        for (const b of e.currentTarget.parentNode.children) b.classList.remove('on');
        e.currentTarget.classList.add('on');
      },
    }, BG_LABELS[bg])));
    const page = v.page;
    const fsAvailable = !isStandalone() && (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);

    p.append(
      h('div', { class: 'lw-menu-label' }, 'このページの背景'), bgSeg,
      item('板書スペースを下に拡張', () => v.extend()),
      item('拡張した板書スペースを戻す', () => v.resetExtend(), { disabled: !page?.state.extra }),
      item('このページの書き込みを全消去', () => this.actions.clear(), { disabled: !page?.state.strokes.length && !page?.state.texts.length, danger: true }),
      item('このページの数値実験を初期状態に戻す', () => v.resetWidgets(), { disabled: !Object.keys(page?.state.widgets || {}).length }),
      item('この白紙ページを削除', () => {
        if ((page.state.strokes.length || page.state.texts.length) && !confirm('このページには書き込みがあります。削除しますか？')) return;
        v.deletePage(v.index);
      }, { disabled: page?.kind !== 'blank', danger: true }),
      h('hr'),
      toggle('筆圧で線の太さを変える', 'pressure'),
      toggle('ペン先のダブルタップでペン⇔消しゴム', 'penDoubleTap'),
      toggle('指でも書く（ペンがないとき）', 'fingerDraw'),
      toggle('指の横スワイプでページ送り', 'swipe'),
      h('div', { class: 'lw-menu-label' }, 'ページの切り替え方'),
      h('div', { class: 'lw-seg' }, [['slide', 'スライド（滑らかに）'], ['instant', 'すぐ切り替え']].map(([v, label]) => h('button', {
        type: 'button', class: 'lw-seg-btn' + (s.get('pageTransition') === v ? ' on' : ''),
        onclick: (e) => {
          s.set('pageTransition', v);
          for (const b of e.currentTarget.parentNode.children) b.classList.remove('on');
          e.currentTarget.classList.add('on');
        },
      }, label))),
      toggle('授業モードでページ送りボタン（左下）を表示', 'pageButtons'),
      h('hr'),
      item('PDF に書き出す（書き込み付き）', () => this.actions.exportPdf()),
      h('div', { class: 'lw-menu-label' }, 'バックアップ（端末間の移動・復元用）'),
      item('バックアップを保存（.json）', () => this.actions.exportInk()),
      item('バックアップから復元…', () => this.actions.importInk()),
      h('hr'),
      fsAvailable ? item('全画面表示', () => toggleFullscreen()) : null,
      item('動作の記録（不具合の報告用）', () => this.actions.diag()),
      item('ライブラリ（教材一覧）へ戻る', () => this.actions.home()),
    );
    const r = anchor.getBoundingClientRect();
    p.style.top = r.bottom + 6 + 'px';
    p.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    this.el.hidden = false;
  }
}

export function toggleFullscreen() {
  const d = document;
  const el = d.documentElement;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
}
