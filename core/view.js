// =============================================================
// PageView：講義画面（1 ページずつ表示）
//
//   #stage（縦スクロール） > .lw-sizer（表示サイズ） > .lw-page（論理サイズ, transform:scale）
//        .lw-page の中身： .lw-content（教材） / .lw-text-layer（テキスト）/ .lw-ink-hl / .lw-ink-pen / .lw-ink-live
//
// 教材と手書きは同じ論理座標系（幅 PAGE_WIDTH）で配置され、ページ要素ごと
// CSS transform で拡大縮小する。画面サイズ・回転・スクロールが変わっても
// 両者の相対位置は変わらない。
// =============================================================
import { PAGE_WIDTH, MIN_VISIBLE_RATIO, MAX_INK_RESOLUTION, TILE_MARGIN_SCREENS, EXTEND_RATIO } from './config.js';
import { h, Emitter, rafThrottle, clamp, rect } from './util.js';
import { diag, timed } from './diag.js';
import { InkLayer, LiveLayer } from './ink/layer.js';
import { LaserLayer } from './ink/laser.js';
import { TextLayer } from './ink/text.js';
import { InkController } from './ink/controller.js';
import { InkInput } from './ink/input.js';
import { strokesBottom } from './ink/stroke.js';
import { opBounds, diffStrokes } from './ink/history.js';
import { mountWidgets } from './widgets/index.js';
import { pdfPageHeight, renderPdfPage, releasePdfCanvas } from './content/pdf.js';

export class PageView extends Emitter {
  constructor({ stage, book, lecture, settings }) {
    super();
    this.stage = stage;
    this.book = book;
    this.lecture = lecture;
    this.settings = settings;

    this.sizer = h('div', { class: 'lw-sizer' });
    this.pageEl = h('div', { class: 'lw-page' });
    this.sizer.appendChild(this.pageEl);
    stage.appendChild(this.sizer);
    this.hl = new InkLayer(this.pageEl, 'hl');
    this.pen = new InkLayer(this.pageEl, 'pen');
    this.live = new LiveLayer(this.pageEl);
    this.laser = new LaserLayer(this.pageEl, this);
    this.cursor = h('div', { class: 'lw-eraser-cursor' });
    this.pageEl.appendChild(this.cursor);
    this.texts = new TextLayer(this);

    this.scale = 1;
    this.dpr = window.devicePixelRatio || 1;
    this.H = 0;
    this.minH = 0;
    this.index = -1;
    this.page = null;
    this.contents = new Map();

    this.ink = new InkController(this, settings);
    this.input = new InkInput({ el: this.pageEl, scroller: stage, settings, controller: this.ink });

    const view = this;
    this.widgetEnv = {
      get scale() { return view.scale; },
      get dpr() { return view.dpr; },
      renderer: lecture.renderer,
      lectureBase: lecture.base,
    };

    this._relayout = rafThrottle(() => this.layout());
    this._updateTiles = rafThrottle(() => this.updateTiles());
    new ResizeObserver(() => this._relayout()).observe(stage);
    this.contentObserver = new ResizeObserver(() => this._relayout());
    window.addEventListener('resize', () => this._relayout());
    stage.addEventListener('scroll', () => this._updateTiles(), { passive: true });
  }

  // ---- 参照 ----
  layer(kind) { return kind === 'hl' ? this.hl : this.pen; }
  get inkResolution() { return Math.min(MAX_INK_RESOLUTION, this.scale * this.dpr); }

  /** 表示中の論理 y 範囲（margin は画面高さに対する比） */
  visibleRange(margin = 0) {
    const s = this.scale;
    const top = this.stage.scrollTop / s;
    const hgt = this.stage.clientHeight / s;
    return { top: top - hgt * margin, bottom: top + hgt * (1 + margin) };
  }

  // ---- ページ表示 ----
  show(index, opts = {}) {
    if (!this.book.length) return;
    const t0 = performance.now();
    this._show(index, opts);
    const ms = performance.now() - t0;
    diag('page', `${this.index + 1} ページを表示 ${Math.round(ms)}ms`);
  }

  _show(index, { scrollTop } = {}) {
    index = clamp(index, 0, this.book.length - 1);
    this.input.finish();
    this.texts.commit();
    this.laser.clear();

    const prev = this.page;
    if (prev) {
      const c = this.contents.get(prev.id);
      if (c) {
        c.scrollTop = this.stage.scrollTop / this.scale;
        this.contentObserver.unobserve(c.el);
        for (const w of c.widgets) w.hide();
        for (const m of c.el.querySelectorAll('video, audio')) m.pause();
        c.el.remove();
      }
    }

    this.index = index;
    const page = this.book.pages[index];
    this.page = page;
    const c = this.content(page);
    this.pageEl.prepend(c.el);
    this.applyBackground();
    if (!c.mounted) {
      c.mounted = true;
      c.widgets = mountWidgets(c.el, this.lecture.widgets, this.widgetEnv, this.paramState(page));
    }
    this.hl.setStrokes(page.state.strokes);
    this.pen.setStrokes(page.state.strokes);
    this.syncHlLayer();
    this.texts.render();
    this.layout();
    this.updatePdf();
    for (const w of c.widgets) w.show();
    this.stage.scrollTop = (scrollTop ?? c.scrollTop ?? 0) * this.scale;
    this.updateTiles();
    this.contentObserver.observe(c.el);
    this.book.setLastPage(page.id);
    try { history.replaceState(null, '', `#${index + 1}`); } catch { /* 無視 */ }
    this.emit('page', index);
  }

  next() { this.turn(1); }
  prev() { this.turn(-1); }

  /** ページ送りの切り替え中（スライドの動きの最中は書き込みを受け付けない） */
  get turning() { return !!this._turning; }

  /**
   * 前後のページへ送る。設定 pageTransition が 'slide' なら、今のページが横に抜けて
   * 次のページが反対側から滑り込む（指で引っ張っている途中の位置から続けて動く）。
   */
  turn(delta) {
    const to = this.index + delta;
    if (to < 0 || to >= this.book.length) { this.slideBack(); return; }
    if (this._turning) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (this.settings.get('pageTransition') !== 'slide' || reduce) {
      this.slideTo(0, false);
      this.show(to);
      return;
    }
    this._turning = true;
    this.input.finish();
    const el = this.sizer;
    const W = this.stage.clientWidth;
    const dir = delta > 0 ? -1 : 1;
    el.style.transition = 'transform 150ms ease-in, opacity 150ms ease-in';
    el.style.transform = `translateX(${dir * W * 0.5}px)`;
    el.style.opacity = '0';
    setTimeout(() => {
      el.style.transition = 'none';
      this.show(to);
      el.style.transform = `translateX(${-dir * W * 0.5}px)`;
      void el.offsetWidth;   // いったん反対側に置いてから滑り込ませる
      el.style.transition = 'transform 200ms ease-out, opacity 200ms ease-out';
      el.style.transform = '';
      el.style.opacity = '';
      setTimeout(() => { el.style.transition = ''; this._turning = false; }, 220);
    }, 150);
  }

  /** 指で引っ張っている間のページの横位置（px）。animate なら滑らかに動かす */
  slideTo(x, animate) {
    const el = this.sizer;
    el.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    el.style.transform = x ? `translateX(${x}px)` : '';
  }
  slideBack() { if (this.sizer.style.transform) this.slideTo(0, true); }

  /** ページの教材 DOM（初回のみ生成してキャッシュ） */
  content(page) {
    let c = this.contents.get(page.id);
    if (c) return c;
    const el = document.createElement('div');
    el.className = 'lw-content';
    if (page.kind === 'source' && page.source.pdf) {
      // PDF のページ：幅 PAGE_WIDTH に合わせたキャンバス（描画は updatePdf で）
      const H = pdfPageHeight(page.source.pdf);
      el.classList.add('lw-content-pdf');
      el.style.height = H + 'px';
      const cv = h('canvas', { class: 'lw-pdf-canvas' });
      cv.width = cv.height = 0;
      cv.style.width = PAGE_WIDTH + 'px';
      cv.style.height = H + 'px';
      el.appendChild(cv);
      c = { el, widgets: [], mounted: true, scrollTop: 0, pdfCanvas: cv };
      this.contents.set(page.id, c);
      return c;
    }
    if (page.kind === 'source') {
      const o = page.source.opts;
      if (o.layout) el.classList.add('lw-layout-' + o.layout);
      if (o.class) for (const x of String(o.class).split(/\s+/)) if (x) el.classList.add(x);
      el.innerHTML = page.source.html;
      resolveUrls(el, this.lecture.base);
    } else {
      el.classList.add('lw-content-blank');
    }
    c = { el, widgets: [], mounted: false, scrollTop: 0 };
    this.contents.set(page.id, c);
    return c;
  }

  /** 全教材ページの DOM を先に作る（画像の先読み） */
  preloadContents() {
    for (const p of this.book.pages) if (p.kind === 'source') this.content(p);
  }

  backgroundOf(page) {
    return page.state.bg || (page.kind === 'source' ? page.source.opts.bg : null) || 'none';
  }

  applyBackground() {
    this.pageEl.dataset.bg = this.backgroundOf(this.page);
  }

  /**
   * PDF ページの描画管理：表示中のページをすぐ描画し、前後のページは少し後（書いている最中は
   * 書き終わってから）に描画しておく（ページ送りを即座にしつつ、送った直後に重くならないように）。
   * 離れたページのビットマップは解放してメモリを抑える。
   */
  updatePdf() {
    const r = this.inkResolution;
    const keep = new Set();
    const render = (p, c) => {
      const t0 = performance.now();
      renderPdfPage(p.source.pdf, c.pdfCanvas, r).then((done) => {
        const ms = performance.now() - t0;
        if (done && ms > 400) diag('pdf', `p.${p.source.pdf.n} ${Math.round(ms)}ms`);
      }, (e) => { console.error('PDF の描画に失敗', e); diag('error', `PDF の描画: ${e?.message || e}`); });
    };
    for (const d of [0, 1, -1, 2]) {
      const p = this.book.pages[this.index + d];
      if (!p || !p.source?.pdf) continue;
      const c = this.content(p);
      keep.add(c);
      if (d === 0) render(p, c);
    }
    clearTimeout(this._pdfTimer);
    const neighbors = () => {
      if (this.ink.active) { this._pdfTimer = setTimeout(neighbors, 300); return; }
      for (const d of [1, -1]) {
        const p = this.book.pages[this.index + d];
        if (p?.source?.pdf) render(p, this.content(p));
      }
    };
    this._pdfTimer = setTimeout(neighbors, 450);
    for (const c of this.contents.values()) {
      if (c.pdfCanvas && !keep.has(c) && c.pdfCanvas.width > 0) releasePdfCanvas(c.pdfCanvas);
    }
  }

  /**
   * 印刷（PDF 出力）用に、ページの教材を複製して返す。
   * 未表示のページはウィジェットを初期化し、キャンバスは画像に置き換える。
   * @returns {Promise<{ node: HTMLElement, height: number }>}
   */
  async printSnapshot(page, host) {
    const c = this.content(page);
    const attached = c.el.isConnected;
    if (!attached) host.appendChild(c.el);
    try {
      if (!c.mounted) {
        c.mounted = true;
        c.widgets = mountWidgets(c.el, this.lecture.widgets, this.widgetEnv, this.paramState(page));
        for (const w of c.widgets) w.hide();
      }
      const height = c.el.offsetHeight;
      const node = c.el.cloneNode(true);
      const src = c.el.querySelectorAll('canvas');
      const dst = node.querySelectorAll('canvas');
      for (let i = 0; i < dst.length; i++) {
        const s = src[i];
        let url = '';
        if (s === c.pdfCanvas) {
          const tmp = document.createElement('canvas');
          await renderPdfPage(page.source.pdf, tmp, 2);
          url = tmp.toDataURL('image/jpeg', 0.9);
          tmp.width = tmp.height = 0;
        } else if (s.width > 1 && s.height > 1) {
          url = s.toDataURL('image/png');
        }
        const img = document.createElement('img');
        img.className = dst[i].className;
        img.style.cssText = dst[i].style.cssText;
        if (url) img.src = url;
        dst[i].replaceWith(img);
      }
      for (const m of node.querySelectorAll('video, iframe')) {
        const w = m.style.width || (m.getAttribute('width') ? m.getAttribute('width') + 'px' : '640px');
        const hh = m.style.height || (m.getAttribute('height') ? m.getAttribute('height') + 'px' : '360px');
        let ph;
        if (m.tagName === 'VIDEO' && m.getAttribute('poster')) {
          ph = h('img', { src: m.getAttribute('poster') });
        } else {
          ph = h('div', { class: 'lw-print-media' }, m.tagName === 'VIDEO' ? '（動画）' : '（埋め込みコンテンツ）');
        }
        ph.style.width = w;
        ph.style.height = hh;
        m.replaceWith(ph);
      }
      return { node, height };
    } finally {
      if (!attached) c.el.remove();
    }
  }

  get background() { return this.pageEl.dataset.bg || 'none'; }

  /** 数値実験の値の保存先（ページの state.widgets） */
  paramState(page) {
    return {
      get: (key) => page.state.widgets[key] || null,
      set: (key, values) => {
        if (values) page.state.widgets[key] = values;
        else delete page.state.widgets[key];
        this.book.markDirty(page);
      },
    };
  }

  /** このページの数値実験を初期値に戻す */
  resetWidgets() {
    const page = this.page;
    const c = page && this.contents.get(page.id);
    if (!c) return false;
    for (const w of c.widgets) w._resetParams?.();
    page.state.widgets = {};
    this.book.markDirty(page);
    return true;
  }

  // ---- レイアウト ----
  layout() {
    const page = this.page;
    if (!page) return;
    const c = this.contents.get(page.id);
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    if (!sw || !sh) return;

    const s = Math.min(sw / PAGE_WIDTH, sh / (PAGE_WIDTH * MIN_VISIBLE_RATIO));
    const dpr = window.devicePixelRatio || 1;
    const scaleChanged = Math.abs(s - this.scale) > 1e-4 || dpr !== this.dpr;
    const logicalTop = this.stage.scrollTop / this.scale;
    this.scale = s;
    this.dpr = dpr;

    // 教材のレイアウトは画面サイズに依存させない（回転で教材だけ動くと書き込みとずれる）。
    // 画面サイズに応じて変わるのはページ下部の余白（＝板書スペース）だけ。
    const minH = Math.floor(sh / s);
    this.minH = minH;
    const base = Math.max(c.el.offsetHeight, minH) + (page.state.extra || 0);
    const H = Math.ceil(Math.max(base, strokesBottom(page.state.strokes) + 24, this.texts.bottom() + 24));
    this.H = H;

    this.sizer.style.width = PAGE_WIDTH * s + 'px';
    this.sizer.style.height = H * s + 'px';
    this.pageEl.style.height = H + 'px';
    this.pageEl.style.transform = `scale(${s})`;
    this.hl.setGeometry(PAGE_WIDTH, H, this.inkResolution);
    this.pen.setGeometry(PAGE_WIDTH, H, this.inkResolution);

    if (scaleChanged) {
      this.stage.scrollTop = logicalTop * s;
      for (const w of c.widgets) w.resize();
      this.updatePdf();
      this.emit('scale', s);
    }
    this.updateTiles();
  }

  updateTiles() {
    const { top, bottom } = this.visibleRange(TILE_MARGIN_SCREENS);
    timed('ink', '書き込みの再描画', 80, () => {
      this.hl.updateVisible(top, bottom);
      this.pen.updateVisible(top, bottom);
    });
  }

  // ---- 手書き関連の操作 ----
  redrawInk(region) {
    timed('ink', '書き込みの再描画', 80, () => {
      this.hl.redraw(region);
      this.pen.redraw(region);
    });
  }

  inkChanged(page) {
    this.book.markDirty(page);
    if (page === this.page) this.syncHlLayer();
    this.emit('ink', page);
  }

  /**
   * 蛍光ペンの層は、このページに蛍光ペンの線があるとき（または描いている間）だけ表示・合成する。
   * 乗算の合成（mix-blend-mode）は画面を描き直すたびに GPU を使い、電池を消費するため。
   */
  syncHlLayer(force = false) {
    const on = force || !!this.page?.state.strokes.some((s) => s.t === 'hl');
    this.hl.el.classList.toggle('lw-active', on);
  }

  undo() { this._history('undo'); }
  redo() { this._history('redo'); }

  _history(dir) {
    const page = this.page;
    if (!page || this.ink.active) return;
    this.texts.commit();
    const op = page.history[dir](page.state);
    if (!op) return;
    if (op.texts) this.texts.render();
    if (op.extra || op.texts) this.layout();
    const b = opBounds(op);
    if (b) this.redrawInk(b);
    this.inkChanged(page);
  }

  /** 直近の操作を取り消す（やり直しの履歴にも残さない。ペン先のダブルタップで付けた点などに使う） */
  revertOps(page, ops) {
    let b = null;
    for (const op of ops) {
      if (!op) continue;
      const st = page.history.undoStack;
      if (st[st.length - 1] !== op) continue;
      page.history.undo(page.state);
      page.history.redoStack.pop();
      b = rect.union(b, opBounds(op));
    }
    if (page !== this.page) return;
    if (b) this.redrawInk(b);
    this.inkChanged(page);
  }

  get canUndo() { return !!this.page?.history.canUndo; }
  get canRedo() { return !!this.page?.history.canRedo; }

  /** ページの書き込み（手書き・テキスト）を全消去（Undo 可能） */
  clearPage() {
    const page = this.page;
    if (!page || this.ink.active) return false;
    this.texts.commit();
    if (!page.state.strokes.length && !page.state.texts.length) return false;
    const op = diffStrokes(page.state.strokes.slice(), []);
    if (page.state.texts.length) op.texts = page.state.texts.map((t, i) => ({ i, a: t, b: null }));
    page.state.strokes.length = 0;
    page.state.texts.length = 0;
    page.history.push(op);
    this.redrawInk(null);
    this.texts.render();
    this.inkChanged(page);
    return true;
  }

  /** 板書スペースを下に拡張（Undo 可能） */
  extend() {
    const page = this.page;
    if (!page) return;
    const before = page.state.extra || 0;
    page.state.extra = before + Math.round(this.minH * EXTEND_RATIO);
    page.history.push({ removed: [], added: [], extra: [before, page.state.extra] });
    this.layout();
    this.inkChanged(page);
    this.stage.scrollTo({ top: this.stage.scrollHeight, behavior: 'smooth' });
  }

  /** 拡張した板書スペースを戻す（書き込みがある範囲は残る） */
  resetExtend() {
    const page = this.page;
    if (!page || !page.state.extra) return;
    const before = page.state.extra;
    page.state.extra = 0;
    page.history.push({ removed: [], added: [], extra: [before, 0] });
    this.layout();
    this.inkChanged(page);
  }

  setBackground(bg) {
    const page = this.page;
    if (!page) return;
    page.state.bg = bg;
    this.applyBackground();
    this.book.markDirty(page);
  }

  addBlankPage(bg = 'none') {
    const i = this.book.addBlank(this.index, bg);
    this.show(i, { scrollTop: 0 });
  }

  deletePage(index) {
    const page = this.book.pages[index];
    if (!page || page.kind !== 'blank') return false;
    const wasCurrent = index === this.index;
    if (wasCurrent) { this.input.finish(); this.texts.commit(); }
    const c = this.contents.get(page.id);
    if (c) { c.el.remove(); this.contents.delete(page.id); }
    if (wasCurrent) this.page = null;
    this.book.removeBlank(index);
    const next = wasCurrent ? Math.min(index, this.book.length - 1) : (index < this.index ? this.index - 1 : this.index);
    this.index = -1;
    this.show(next);
    return true;
  }

  showEraser(x, y, r) {
    const c = this.cursor;
    c.style.display = 'block';
    c.style.width = c.style.height = 2 * r + 'px';
    c.style.transform = `translate(${x - r}px, ${y - r}px)`;
  }

  hideEraser() { this.cursor.style.display = 'none'; }
}

/** 教材内の相対 URL（画像・動画など）を講義フォルダ基準に解決する */
function resolveUrls(root, base) {
  for (const el of root.querySelectorAll('[src], [href], [poster]')) {
    for (const attr of ['src', 'href', 'poster']) {
      const v = el.getAttribute(attr);
      if (v && !/^([a-z][\w+.-]*:|\/|#)/i.test(v)) el.setAttribute(attr, new URL(v, base).href);
    }
    if (el.tagName === 'A' && /^https?:/i.test(el.getAttribute('href') || '')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener');
    }
    if (el.tagName === 'IMG') el.setAttribute('draggable', 'false');
  }
}
