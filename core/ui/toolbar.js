// =============================================================
// 上部の小型ツールバー
//   [ページ一覧][<][3/12][>][+白紙]  [操作][ペン][蛍光][消しゴム][レーザー][テキスト]  [色・太さ]  …  [↶][↷][拡張][消去][⋯][▲]
// 最小化（compact）すると右上の小さなパレットになる。
// =============================================================
import { h } from '../util.js';
import { ICONS } from './icons.js';
import { PEN_COLORS, PEN_WIDTHS, HL_COLORS, HL_WIDTHS, ERASER_SIZES, LASER_COLORS, TEXT_SIZES } from '../config.js';

const TOOL_NAMES = { hand: '操作（ペンで教材を操作）', pen: 'ペン', hl: '蛍光ペン', eraser: '消しゴム', laser: 'レーザーポインタ（書き込まれない）', text: 'テキスト（タップした所に入力。$...$ で数式）' };

export class Toolbar {
  /** actions: { overview(), menu(anchorEl), addPage(), clear() } */
  constructor({ root, view, settings, actions }) {
    this.view = view;
    this.settings = settings;
    this.actions = actions;

    const btn = (icon, title, onclick, cls = '') =>
      h('button', { type: 'button', class: `lw-tb-btn ${cls}`, title, 'aria-label': title, html: ICONS[icon], onclick });

    this.pageNo = h('button', { type: 'button', class: 'lw-tb-pageno', title: 'ページ一覧', onclick: () => actions.overview() });
    this.prevBtn = btn('prev', '前のページ（←）', () => view.prev(), 'keep');
    this.nextBtn = btn('next', '次のページ（→）', () => view.next(), 'keep');
    const nav = h('div', { class: 'lw-tb-group' },
      btn('pages', 'ページ一覧', () => actions.overview(), 'wide-only'),
      this.prevBtn, this.pageNo, this.nextBtn,
      btn('addPage', '白紙ページを追加', () => actions.addPage()));

    this.toolBtns = {};
    const tools = h('div', { class: 'lw-tb-group lw-tb-tools' });
    for (const [tool, icon] of [['hand', 'hand'], ['pen', 'pen'], ['hl', 'highlighter'], ['eraser', 'eraser'], ['laser', 'laser'], ['text', 'text']]) {
      const b = btn(icon, TOOL_NAMES[tool], () => settings.set('tool', tool), 'keep');
      this.toolBtns[tool] = b;
      tools.appendChild(b);
    }

    this.opts = h('div', { class: 'lw-tb-group lw-tb-opts' });

    this.undoBtn = btn('undo', '元に戻す（⌘Z）', () => view.undo(), 'keep');
    this.redoBtn = btn('redo', 'やり直す（⇧⌘Z）', () => view.redo());
    this.moreBtn = btn('more', 'メニュー', () => actions.menu(this.moreBtn));
    this.compactBtn = btn('collapse', 'ツールバーを最小化', () => settings.toggle('compact'), 'keep');
    const acts = h('div', { class: 'lw-tb-group' },
      this.undoBtn, this.redoBtn,
      btn('extend', '板書スペースを下に拡張', () => view.extend(), 'wide-only'),
      btn('trash', 'このページの書き込みを全消去', () => actions.clear(), 'wide-only'),
      this.moreBtn, this.compactBtn);

    this.el = h('header', { class: 'lw-toolbar' }, nav, tools, this.opts, h('div', { class: 'lw-tb-spacer' }), acts);
    root.appendChild(this.el);
    // ボタンを押しても入力中のテキストからフォーカスを外さない（色・サイズを入力中の文字に適用するため）
    this.el.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });

    settings.on('change', (k) => {
      if (['tool', 'penColor', 'penWidth', 'hlColor', 'hlWidth', 'eraserMode', 'eraserSize', 'laserMode', 'laserColor', 'textColor', 'textSize'].includes(k)) this.syncTools();
      if (k === 'compact') this.syncCompact();
    });
    view.on('page', () => this.syncPage());
    view.on('ink', () => this.syncHistory());
    this.syncTools();
    this.syncCompact();
  }

  syncPage() {
    this.pageNo.textContent = `${this.view.index + 1} / ${this.view.book.length}`;
    this.prevBtn.disabled = this.view.index <= 0;
    this.nextBtn.disabled = this.view.index >= this.view.book.length - 1;
    this.syncHistory();
  }

  syncHistory() {
    this.undoBtn.disabled = !this.view.canUndo;
    this.redoBtn.disabled = !this.view.canRedo;
  }

  syncCompact() {
    const c = this.settings.get('compact');
    this.el.classList.toggle('compact', c);
    document.body.classList.toggle('lw-compact', c);
    this.compactBtn.innerHTML = c ? ICONS.expand : ICONS.collapse;
    this.compactBtn.title = c ? 'ツールバーを元に戻す' : 'ツールバーを最小化';
  }

  syncTools() {
    const s = this.settings;
    const tool = s.get('tool');
    for (const [k, b] of Object.entries(this.toolBtns)) b.classList.toggle('on', k === tool);
    document.body.dataset.tool = tool;
    const o = this.opts;
    o.textContent = '';
    if (tool === 'pen' || tool === 'hl') {
      const colors = tool === 'pen' ? PEN_COLORS : HL_COLORS;
      const widths = tool === 'pen' ? PEN_WIDTHS : HL_WIDTHS;
      const curC = s.get(tool + 'Color');
      const curW = s.get(tool + 'Width');
      for (const c of colors) {
        const b = h('button', { type: 'button', class: 'lw-swatch' + (c === curC ? ' on' : ''), title: c, onclick: () => s.set(tool + 'Color', c) }, h('span'));
        b.style.setProperty('--c', c);
        o.appendChild(b);
      }
      o.appendChild(h('span', { class: 'lw-tb-sep' }));
      widths.forEach((w, i) => {
        const d = tool === 'pen' ? 4 + i * 4 : 6 + i * 5;
        const dot = h('span', { style: { width: d + 'px', height: d + 'px' } });
        const b = h('button', { type: 'button', class: 'lw-width' + (w === curW ? ' on' : ''), title: `太さ ${i + 1}`, onclick: () => s.set(tool + 'Width', w) }, dot);
        if (tool === 'hl') dot.style.background = curC;
        o.appendChild(b);
      });
    } else if (tool === 'eraser') {
      const mode = s.get('eraserMode');
      o.appendChild(h('div', { class: 'lw-seg lw-tb-seg' },
        h('button', { type: 'button', class: 'lw-seg-btn' + (mode === 'stroke' ? ' on' : ''), onclick: () => s.set('eraserMode', 'stroke') }, '線ごと'),
        h('button', { type: 'button', class: 'lw-seg-btn' + (mode === 'partial' ? ' on' : ''), onclick: () => s.set('eraserMode', 'partial') }, '部分')));
      o.appendChild(h('span', { class: 'lw-tb-sep' }));
      const cur = s.get('eraserSize');
      ERASER_SIZES.forEach((r, i) => {
        const d = 6 + i * 6;
        const ring = h('span', { class: 'ring', style: { width: d + 'px', height: d + 'px' } });
        o.appendChild(h('button', { type: 'button', class: 'lw-width' + (r === cur ? ' on' : ''), title: `大きさ ${i + 1}`, onclick: () => s.set('eraserSize', r) }, ring));
      });
    } else if (tool === 'laser') {
      const mode = s.get('laserMode');
      o.appendChild(h('div', { class: 'lw-seg lw-tb-seg' },
        h('button', { type: 'button', class: 'lw-seg-btn' + (mode === 'trail' ? ' on' : ''), title: '描いた線が数秒で消える', onclick: () => s.set('laserMode', 'trail') }, '軌跡'),
        h('button', { type: 'button', class: 'lw-seg-btn' + (mode === 'dot' ? ' on' : ''), title: 'ペン先に光る点', onclick: () => s.set('laserMode', 'dot') }, '点')));
      o.appendChild(h('span', { class: 'lw-tb-sep' }));
      const cur = s.get('laserColor');
      for (const c of LASER_COLORS) {
        const b = h('button', { type: 'button', class: 'lw-swatch lw-swatch-laser' + (c === cur ? ' on' : ''), title: c, onclick: () => s.set('laserColor', c) }, h('span'));
        b.style.setProperty('--c', c);
        o.appendChild(b);
      }
    } else if (tool === 'text') {
      const curC = s.get('textColor');
      const curS = s.get('textSize');
      for (const c of PEN_COLORS) {
        const b = h('button', { type: 'button', class: 'lw-swatch' + (c === curC ? ' on' : ''), title: c, onclick: () => s.set('textColor', c) }, h('span'));
        b.style.setProperty('--c', c);
        o.appendChild(b);
      }
      o.appendChild(h('span', { class: 'lw-tb-sep' }));
      TEXT_SIZES.forEach((z, i) => {
        o.appendChild(h('button', { type: 'button', class: 'lw-width lw-tsize' + (z === curS ? ' on' : ''), title: `文字サイズ ${z}`, onclick: () => s.set('textSize', z) },
          h('span', { style: { fontSize: 13 + i * 4 + 'px' } }, 'A')));
      });
    } else {
      o.appendChild(h('span', { class: 'lw-tb-hint' }, 'ペンでも教材を操作できます'));
    }
  }
}
