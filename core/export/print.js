// =============================================================
// PDF 出力（印刷レイアウト）
//
// 全ページを「A4 横」のシートに並べた印刷用 DOM を作り、window.print() で
// ブラウザの「PDF に保存」を使う。
//   ・教材：表示中の DOM を複製（数式・文字はベクターのまま）。グラフ等のキャンバスは画像化。
//   ・書き込み：SVG（ベクター）。蛍光ペンは半透明で重ねる（印刷では合成モードが効かない環境があるため）。
//   ・テキスト：画面と同じ DOM（文字・数式ともベクター）。教材と手書きの間に重ねる。
//   ・ページ幅をシート幅に合わせ、縦に長いページ（板書スペースを拡張したページ等）は複数シートに分割。
//   ・レーザーポインタは含まない。
// =============================================================
import { h } from '../util.js';
import { PAGE_WIDTH } from '../config.js';
import { strokesBottom } from '../ink/stroke.js';
import { strokesToSvg } from '../ink/svg.js';
import { renderTextLayer, textLayerBottom } from '../ink/text.js';

const PX_PER_MM = 96 / 25.4;
export const SHEET_MM = { w: 297, h: 210 };          // A4 横（print の @page と一致させる）
const SCALE = (SHEET_MM.w * PX_PER_MM) / PAGE_WIDTH;  // 論理px → CSS px
export const SHEET_HEIGHT = (SHEET_MM.h * PX_PER_MM) / SCALE; // 1 シートの論理高さ（≒724）

export function removePrintView() {
  document.getElementById('lw-print')?.remove();
  document.body.classList.remove('lw-printing');
}

/**
 * 印刷用 DOM を作って body に追加する（画面には表示されない）。
 * @param {{ view: PageView, book: Book, onProgress?: (i, n) => void }} o
 * @returns {Promise<{ root: HTMLElement, sheets: number }>}
 */
export async function buildPrintView({ view, book, onProgress }) {
  removePrintView();
  const root = h('div', { id: 'lw-print' });
  const host = h('div', { class: 'lw-print-host' });
  document.body.appendChild(host);
  let sheets = 0;
  try {
    for (let i = 0; i < book.length; i++) {
      const page = book.pages[i];
      onProgress?.(i, book.length);
      const { node, height } = await view.printSnapshot(page, host);
      let texts = null;
      let textBottom = 0;
      if (page.state.texts.length) {
        texts = renderTextLayer(page.state.texts, view.lecture.renderer);
        host.appendChild(texts);           // 大きさを測るために一時的に配置
        textBottom = textLayerBottom(texts);
        texts.remove();
      }
      const H = Math.ceil(Math.max(height, strokesBottom(page.state.strokes) + 24, textBottom + 24, 100));
      const n = Math.max(1, Math.ceil((H - 20) / SHEET_HEIGHT));
      const svg = strokesToSvg(page.state.strokes, PAGE_WIDTH, H);
      for (let j = 0; j < n; j++) {
        const pg = h('div', { class: 'lw-print-page', dataset: { bg: view.backgroundOf(page) } });
        pg.style.height = H + 'px';
        pg.style.transform = `scale(${SCALE}) translateY(${-j * SHEET_HEIGHT}px)`;
        pg.appendChild(j === 0 ? node : node.cloneNode(true));
        if (texts) pg.appendChild(j === 0 ? texts : texts.cloneNode(true));
        pg.insertAdjacentHTML('beforeend', svg);
        root.appendChild(h('section', { class: 'lw-print-sheet' }, pg));
        sheets++;
      }
      // 長い処理の途中で画面が固まらないように
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    host.remove();
  }
  document.body.appendChild(root);
  await Promise.race([
    Promise.all([...root.querySelectorAll('img')].map((img) => img.decode?.().catch(() => {}))),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  return { root, sheets };
}
