// =============================================================
// PDF 教材（既存のスライド・資料の再利用）
//   lecture.md に「@pdf slides.pdf pages=1-10」と書くと、PDF の各ページが
//   講義のページになる（PDF.js で描画し、その上に手書きできる）。
//   PowerPoint / Keynote の資料は PDF に書き出してから使う。
// =============================================================
import { PAGE_WIDTH } from '../config.js';

const VENDOR = new URL('../../vendor/pdfjs/', import.meta.url);
let lib = null;

export function loadPdfjs() {
  if (!lib) {
    lib = import(new URL('pdf.min.mjs', VENDOR).href).then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR).href;
      return m;
    });
  }
  return lib;
}

export async function openPdf(url) {
  const pdfjs = await loadPdfjs();
  // PDF 本体・文字コード表・標準フォントはメインスレッドで取得する
  // （Service Worker 経由で端末内から読めるように。ワーカー内の fetch は環境によって SW を通らない）
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PDF が見つかりません（HTTP ${res.status}）`);
  const data = new Uint8Array(await res.arrayBuffer());
  return pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    cMapUrl: new URL('cmaps/', VENDOR).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', VENDOR).href,
    wasmUrl: new URL('wasm/', VENDOR).href,
    iccUrl: new URL('iccs/', VENDOR).href,
    isEvalSupported: false,
    enableXfa: false,
  }).promise;
}

/** "1-3,5,8-" → [1,2,3,5,8,…,n]（省略時は全ページ） */
export function parseRange(spec, n) {
  if (spec == null || spec === '' || spec === true) return Array.from({ length: n }, (_, i) => i + 1);
  const out = [];
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d*)\s*(-?)\s*(\d*)\s*$/.exec(part);
    if (!m || (!m[1] && !m[3])) continue;
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? (m[3] ? Number(m[3]) : n) : a;
    for (let k = Math.max(1, a); k <= Math.min(n, b); k++) out.push(k);
  }
  return out;
}

/** PDF ページを幅 PAGE_WIDTH にしたときの論理高さ */
export function pdfPageHeight(pdf) {
  return Math.round((PAGE_WIDTH * pdf.h) / pdf.w);
}

/**
 * PDF ページをキャンバスに描画（解像度 r = 実ピクセル / 論理px）。
 * 別キャンバスに描いてから転写するので、描画中に画面が白くならない。
 * 同じ解像度で描画済み・描画中なら何もしない。
 */
export function renderPdfPage(pdf, canvas, r) {
  const st = canvas._lw || (canvas._lw = {});
  if (st.done && st.r === r) return Promise.resolve(true);
  if (st.task && st.pendingR === r) return st.promise;
  if (st.task) {
    try { st.task.cancel(); } catch { /* 既に完了 */ }
  }
  const vp = pdf.page.getViewport({ scale: (PAGE_WIDTH * r) / pdf.w });
  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, Math.round(vp.width));
  tmp.height = Math.max(1, Math.round(vp.height));
  const task = pdf.page.render({ canvasContext: tmp.getContext('2d'), viewport: vp, background: 'white' });
  st.task = task;
  st.pendingR = r;
  st.promise = task.promise.then(() => {
    if (st.task !== task) return false;
    st.task = null;
    canvas.width = tmp.width;
    canvas.height = tmp.height;
    canvas.getContext('2d').drawImage(tmp, 0, 0);
    tmp.width = tmp.height = 0;
    st.done = true;
    st.r = r;
    return true;
  }, (e) => {
    if (st.task === task) st.task = null;
    tmp.width = tmp.height = 0;
    if (e?.name === 'RenderingCancelledException') return false;
    throw e;
  });
  return st.promise;
}

/** 描画済みのビットマップを捨ててメモリを解放 */
export function releasePdfCanvas(canvas) {
  const st = canvas._lw;
  if (st?.task) {
    try { st.task.cancel(); } catch { /* */ }
  }
  canvas.width = canvas.height = 0;
  canvas._lw = {};
}

/** ページの最初のまとまった文字列（ページ一覧の見出し用） */
export async function pdfPageTitle(page) {
  try {
    const tc = await page.getTextContent();
    const wide = (ch) => /[^\x00-\x7f]/.test(ch || '');
    let line = '';
    for (const it of tc.items) {
      // NFKC：PDF でよくある互換文字（⼯ → 工 など）を通常の文字に
      const s = (it.str || '').normalize('NFKC').trim();
      if (s) line += line && !(wide(line.at(-1)) && wide(s[0])) ? ' ' + s : s;
      if (it.hasEOL && line.length >= 2) break;
      if (line.length >= 40) break;
    }
    return line.slice(0, 50);
  } catch {
    return '';
  }
}
