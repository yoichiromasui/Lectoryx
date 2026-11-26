// ツール設定などの端末ローカル設定（localStorage）
import { Emitter } from './util.js';
import { PEN_COLORS, PEN_WIDTHS, HL_COLORS, HL_WIDTHS, ERASER_SIZES, LASER_COLORS, TEXT_SIZES } from './config.js';

const KEY = 'lw.settings.v1';

const DEFAULTS = {
  tool: 'pen',               // 'hand' | 'pen' | 'hl' | 'eraser' | 'laser' | 'text'
  laserMode: 'trail',        // 'trail'（軌跡が数秒で消える） | 'dot'（ペン先に光点）
  laserColor: LASER_COLORS[0],
  penColor: PEN_COLORS[0],
  penWidth: PEN_WIDTHS[1],
  hlColor: HL_COLORS[0],
  hlWidth: HL_WIDTHS[1],
  eraserMode: 'stroke',      // 'stroke'（ストローク単位） | 'partial'（部分）
  eraserSize: ERASER_SIZES[1],
  textColor: PEN_COLORS[0],
  textSize: TEXT_SIZES[1],
  pressure: true,            // 筆圧で線幅を変える
  penDoubleTap: true,        // ペン先のダブルタップでペン⇔消しゴム
  fingerDraw: false,         // 指でも書く（Apple Pencil がないとき用）
  swipe: true,               // 指の横スワイプでページ送り
  compact: false,            // ツールバー最小化
};

export class Settings extends Emitter {
  constructor() {
    super();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { /* 無効 */ }
    this.values = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
      if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) this.values[k] = saved[k];
    }
  }
  get(key) { return this.values[key]; }
  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* 容量不足等 */ }
    this.emit('change', key, value);
  }
  toggle(key) { this.set(key, !this.values[key]); }
}
