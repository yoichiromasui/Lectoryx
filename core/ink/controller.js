// =============================================================
// ツールの動作（ペン・蛍光ペン・消しゴム・レーザーポインタ・テキスト）
// InkInput から論理座標の点を受け取り、ページのストローク配列・描画レイヤー・
// 履歴を更新する。DOM イベントには依存しない。
//
// view に要求するインターフェース:
//   view.page            現在のページ { state:{strokes, extra}, history }
//   view.layer(kind)     InkLayer（'pen' | 'hl'）
//   view.live            LiveLayer
//   view.laser           LaserLayer（保存しない一時表示）
//   view.texts           TextLayer（テキストの配置・編集・移動）
//   view.visibleRange()  表示中の論理 y 範囲 { top, bottom }
//   view.inkResolution   実ピクセル / 論理px
//   view.redrawInk(rect) 指定範囲の再描画
//   view.inkChanged(page)保存・UI 更新の通知
//   view.showEraser(x,y,r) / view.hideEraser()
// =============================================================
import { uid, rect, rafThrottle } from '../util.js';
import { NEUTRAL_PRESSURE, PRESSURE_SMOOTHING, MIN_POINT_DISTANCE, PAGE_WIDTH } from '../config.js';
import { pointCount, round1, round2, strokeBounds } from './stroke.js';
import { strokeHit, splitStroke } from './eraser.js';
import { diffStrokes } from './history.js';

export class InkController {
  constructor(view, settings) {
    this.view = view;
    this.settings = settings;
    this.mode = null;     // null | 'draw' | 'erase'
    this.stroke = null;
    this.page = null;
    this.drawn = 0;       // 本レイヤーに描画済みのセグメント数
    this.pressure = NEUTRAL_PRESSURE;
    this.usePressure = false;
    this.erase = null;
    this.flushErase = rafThrottle(() => this._flushErase());
  }

  get active() { return this.mode !== null; }

  /** pt = { x, y, p, type }（論理座標）。描画を開始したら true */
  begin(pt) {
    const page = this.view.page;
    if (!page || this.mode) return false;
    const tool = this.settings.get('tool');
    this.page = page;

    if (tool === 'pen' || tool === 'hl') {
      const s = { id: uid(), t: tool, c: this.settings.get(tool + 'Color'), w: this.settings.get(tool + 'Width'), p: [] };
      this.usePressure = tool === 'pen' && pt.type === 'pen' && this.settings.get('pressure');
      this.pressure = this.usePressure ? Math.max(0.02, pt.p || 0) : NEUTRAL_PRESSURE;
      this.stroke = s;
      this.drawn = 0;
      this._push(pt, true);
      page.state.strokes.push(s);
      const { top, bottom } = this.view.visibleRange();
      this.view.live.place(top, bottom - top, PAGE_WIDTH, this.view.inkResolution);
      this.view.live.setBlend(tool === 'hl');
      this.mode = 'draw';
      this._render();
      return true;
    }

    if (tool === 'text') {
      this.mode = 'text';
      this.view.texts.begin(pt);
      return true;
    }

    if (tool === 'laser') {
      this.mode = 'laser';
      this.view.laser.begin(pt, this.settings.get('laserMode'), this.settings.get('laserColor'));
      return true;
    }

    if (tool === 'eraser') {
      this.mode = 'erase';
      this.erase = { before: page.state.strokes.slice(), last: pt, dirty: null };
      this._eraseTo(pt);
      this.view.showEraser(pt.x, pt.y, this.settings.get('eraserSize'));
      return true;
    }
    this.page = null;
    return false;
  }

  move(pts) {
    if (this.mode === 'draw') {
      let added = false;
      for (const pt of pts) added = this._push(pt, false) || added;
      if (added) this._render();
    } else if (this.mode === 'laser') {
      this.view.laser.move(pts);
    } else if (this.mode === 'text') {
      this.view.texts.move(pts[pts.length - 1]);
    } else if (this.mode === 'erase') {
      for (const pt of pts) this._eraseTo(pt);
      const last = pts[pts.length - 1];
      this.view.showEraser(last.x, last.y, this.settings.get('eraserSize'));
    }
  }

  end() {
    const page = this.page;
    if (this.mode === 'draw') {
      const s = this.stroke;
      this.view.layer(s.t).drawSegments(s, this.drawn, pointCount(s));
      this.view.live.clear();
      const i = page.state.strokes.indexOf(s);
      if (i >= 0) {
        page.history.push({ removed: [], added: [{ i, s }] });
        this.view.inkChanged(page);
      }
    } else if (this.mode === 'laser') {
      this.view.laser.end();
    } else if (this.mode === 'text') {
      this.view.texts.end();
    } else if (this.mode === 'erase') {
      this.flushErase.cancel();
      this._flushErase();
      const op = diffStrokes(this.erase.before, page.state.strokes);
      if (op.removed.length || op.added.length) {
        page.history.push(op);
        this.view.inkChanged(page);
      }
      this.erase = null;
      this.view.hideEraser();
    }
    this.mode = null;
    this.stroke = null;
    this.page = null;
  }

  /** ペンのホバー（対応機種のみ）：消しゴムの位置を予告表示 */
  hover(pt) {
    if (!this.mode && this.settings.get('tool') === 'eraser') {
      this.view.showEraser(pt.x, pt.y, this.settings.get('eraserSize'));
    }
  }
  hoverEnd() {
    if (!this.mode) this.view.hideEraser();
  }

  // ---- 内部 ----
  _push(pt, force) {
    const p = this.stroke.p;
    const n = p.length;
    const x = round1(Math.min(PAGE_WIDTH + 40, Math.max(-40, pt.x)));
    const y = round1(Math.max(-40, pt.y));
    if (!force && n >= 3) {
      const dx = x - p[n - 3], dy = y - p[n - 2];
      if (dx * dx + dy * dy < MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) return false;
    }
    if (this.usePressure && !force) {
      this.pressure += (Math.max(0.02, pt.p || 0) - this.pressure) * PRESSURE_SMOOTHING;
    }
    p.push(x, y, round2(this.pressure));
    return true;
  }

  _render() {
    const s = this.stroke;
    const n = pointCount(s);
    if (n - 1 > this.drawn) {
      this.view.layer(s.t).drawSegments(s, this.drawn, n - 1);
      this.drawn = n - 1;
    }
    this.view.live.drawTail(s, n - 1);
  }

  _eraseTo(pt) {
    const e = this.erase;
    const a = e.last;
    e.last = pt;
    const r = this.settings.get('eraserSize');
    const partial = this.settings.get('eraserMode') === 'partial';
    const strokes = this.page.state.strokes;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      if (!strokeHit(s, a.x, a.y, pt.x, pt.y, r)) continue;
      if (partial) {
        const pieces = splitStroke(s, a.x, a.y, pt.x, pt.y, r);
        if (!pieces) continue;
        e.dirty = rect.union(e.dirty, strokeBounds(s));
        strokes.splice(i, 1, ...pieces);
      } else {
        e.dirty = rect.union(e.dirty, strokeBounds(s));
        strokes.splice(i, 1);
      }
    }
    if (e.dirty) this.flushErase();
  }

  _flushErase() {
    const e = this.erase;
    if (!e || !e.dirty) return;
    this.view.redrawInk(e.dirty);
    e.dirty = null;
  }
}
