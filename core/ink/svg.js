// =============================================================
// ストローク → SVG（PDF 出力用。ベクターのまま印刷される）
// 画面描画と同じ drawStroke()（ink/stroke.js）の幾何を、Canvas 互換の
// 記録用コンテキストで受けて SVG パスに変換する。線幅がほぼ同じ連続区間は 1 パスにまとめる。
// =============================================================
import { drawStroke } from './stroke.js';

const f = (v) => (Math.round(v * 10) / 10).toString();

class SvgRecorder {
  constructor() {
    this.out = [];
    this.d = '';
    this.cur = null;
    this.circle = null;
    this.strokeStyle = '#000';
    this.fillStyle = '#000';
    this.lineWidth = 1;
  }
  beginPath() { this.d = ''; this.circle = null; }
  moveTo(x, y) { this.d += `M${f(x)} ${f(y)}`; }
  lineTo(x, y) { this.d += `L${f(x)} ${f(y)}`; }
  quadraticCurveTo(cx, cy, x, y) { this.d += `Q${f(cx)} ${f(cy)} ${f(x)} ${f(y)}`; }
  arc(x, y, r) { this.circle = { x, y, r }; }
  stroke() {
    const c = this.cur;
    if (c && c.c === this.strokeStyle && Math.abs(this.lineWidth - c.w) <= c.w * 0.12) {
      c.d += this.d;
    } else {
      this.flush();
      this.cur = { c: this.strokeStyle, w: this.lineWidth, d: this.d };
    }
  }
  fill() {
    this.flush();
    const k = this.circle;
    if (k) this.out.push(`<circle cx="${f(k.x)}" cy="${f(k.y)}" r="${f(k.r)}" fill="${this.fillStyle}"/>`);
  }
  flush() {
    const c = this.cur;
    if (c && c.d) this.out.push(`<path d="${c.d}" stroke="${c.c}" stroke-width="${f(c.w)}"/>`);
    this.cur = null;
  }
}

function group(strokes) {
  const rec = new SvgRecorder();
  for (const s of strokes) {
    drawStroke(rec, s);
    rec.flush();
  }
  return rec.out.join('');
}

/**
 * @param {Stroke[]} strokes
 * @param {number} W 論理幅
 * @param {number} H 論理高さ
 * @returns {string} SVG 文字列（蛍光ペンは半透明のグループ、その上にペン）
 */
export function strokesToSvg(strokes, W, H) {
  const hl = strokes.filter((s) => s.t === 'hl');
  const pen = strokes.filter((s) => s.t !== 'hl');
  const attrs = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg class="lw-print-ink" xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    (hl.length ? `<g ${attrs} opacity="0.5">${group(hl)}</g>` : '') +
    (pen.length ? `<g ${attrs}>${group(pen)}</g>` : '') +
    '</svg>';
}
