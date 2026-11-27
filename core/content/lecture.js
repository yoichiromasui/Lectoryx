// 講義の読み込み：<教材の場所>/lecture.md と widgets.js（と @pdf で指定した PDF）
//   教材の場所は、ダウンロード済みなら端末内（offline/<版>/<パス>/）、そうでなければ配信元。
import { parseLecture, createRenderer } from './markdown.js';
import { openPdf, parseRange, pdfPageTitle } from './pdf.js';
import { escapeHtml } from '../util.js';
import { contentRoot, encodePath } from './source.js';

const FILE_PROTOCOL_MSG =
  'file:// で開かれています。講義ファイルを読み込むには HTTP サーバが必要です。' +
  'プロジェクトのフォルダで「python tools/serve.py」を実行し、表示された URL を開いてください。';

/** URL の ?l=... から講義パスを得る */
export function lecturePathFromUrl() {
  return new URLSearchParams(location.search).get('l') || '';
}

/** 講義パスの検査（教材ルートからの相対パス） */
export function checkPath(path) {
  path = String(path).replace(/^\/+|\/+$/g, '');
  if (!/^[\w\-][\w\-./]*$/.test(path) || path.split('/').includes('..')) {
    throw new Error('講義のパスが不正です: ' + path);
  }
  return path;
}

/**
 * 講義を読み込む
 * @param {string} path  教材ルートからのパス（例 control/01-first-order-lag）
 * @param {{ base?: string }} o  教材フォルダの URL（省略時は配信元から直接）
 * @returns {{id, path, base, meta, pages:[{id,opts,title,src,html,pdf?}], renderer, widgets}}
 *   id は書き込みの保存キー（フロントマターの id: があればそれ、なければパス）。
 *   pdf ページは pages[i].pdf = { doc, page, n, w, h, file }（w,h は PDF の pt）
 */
export async function loadLecture(path, { base } = {}) {
  path = checkPath(path);
  if (location.protocol === 'file:') throw new Error(FILE_PROTOCOL_MSG);

  base = new URL(base || `${encodePath(path)}/`, contentRoot());
  let res;
  try {
    res = await fetch(new URL('lecture.md', base), { cache: 'no-cache' });
  } catch (e) {
    throw new Error(navigator.onLine === false
      ? 'オフラインです。この教材はまだ端末にダウンロードされていません（ライブラリでダウンロードしてください）。'
      : `講義ファイルを読み込めません（${e.message}）`);
  }
  if (!res.ok) throw new Error(`lecture.md が見つかりません（HTTP ${res.status}）: ${base.pathname}lecture.md`);
  const text = await res.text();

  const parsed = parseLecture(text);
  const renderer = createRenderer({ macros: parsed.meta.macros || {} });
  for (const p of parsed.pages) {
    if (p.pdf) continue;
    try {
      p.html = renderer.page(p.src);
    } catch (e) {
      console.error(e);
      p.html = `<div class="lw-error">ページの変換に失敗しました: ${escapeHtml(e.message)}</div>`;
    }
  }
  const [pages, widgets, exercises] = await Promise.all([
    expandPdfPages(parsed.pages, base),
    loadWidgets(base, parsed.meta.widgets),
    loadExercises(base, parsed.pages),
  ]);
  const id = parsed.meta.id ? String(parsed.meta.id) : path;
  return { id, path, base: base.href, meta: parsed.meta, pages, renderer, widgets, exercises };
}

/** @exercise で使う演習（exercises/<id>.json。tools/exercise.py が作る）。読めないものは { error } */
async function loadExercises(base, pages) {
  const ids = new Set();
  for (const p of pages) {
    let fence = null;
    for (const line of (p.src || '').split('\n')) {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (f) { fence = fence ? (line.trim().startsWith(fence) ? null : fence) : f[1]; continue; }
      const m = !fence && /^@exercise\s+([A-Za-z0-9_-]+)/.exec(line);
      if (m) ids.add(m[1]);
    }
  }
  const out = {};
  await Promise.all([...ids].map(async (id) => {
    try {
      const res = await fetch(new URL(`exercises/${id}.json`, base), { cache: 'no-cache' });
      if (!res.ok) throw new Error(`exercises/${id}.json がありません（HTTP ${res.status}）`);
      const ex = await res.json();
      if (ex.format !== 'lectoryx-exercise' || ex.id !== id) throw new Error(`exercises/${id}.json の形式が違います`);
      out[id] = ex;
    } catch (e) {
      out[id] = { error: e.message };
    }
  }));
  return out;
}

/** @pdf のページを PDF の各ページに展開する */
async function expandPdfPages(src, base) {
  if (!src.some((p) => p.pdf)) return src;
  const used = new Set(src.filter((p) => !p.pdf).map((p) => p.id));
  const unique = (id) => {
    let out = id;
    for (let k = 2; used.has(out); k++) out = `${id}~${k}`;
    used.add(out);
    return out;
  };
  const docs = new Map();
  const pages = [];
  for (const p of src) {
    if (!p.pdf) {
      pages.push(p);
      continue;
    }
    const file = String(p.pdf._[0] || p.pdf.src || '');
    try {
      if (!file) throw new Error('@pdf にファイル名がありません');
      const url = new URL(file, base).href;
      if (!docs.has(url)) docs.set(url, openPdf(url));
      const doc = await docs.get(url);
      const prefix = String(p.pdf.id ?? p.opts.id ?? file.replace(/^.*\//, '').replace(/\.pdf$/i, ''));
      for (const n of parseRange(p.pdf.pages, doc.numPages)) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        pages.push({
          id: unique(`${prefix}-${n}`),
          opts: { bg: p.opts.bg },
          title: `${file} p.${n}`,
          src: '',
          html: '',
          pdf: { doc, page, n, w: vp.width, h: vp.height, file },
        });
      }
    } catch (e) {
      console.error(e);
      pages.push({
        id: unique(`pdf-error-${pages.length + 1}`),
        opts: {},
        title: 'PDF の読み込みエラー',
        src: '',
        html: `<div class="lw-error">PDF を読み込めません（${escapeHtml(file)}）: ${escapeHtml(e?.message || String(e))}</div>`,
      });
    }
  }
  return pages;
}

/** PDF ページの見出し（ページ一覧用）を本文から取り出す。起動後にゆっくり実行 */
export async function fillPdfTitles(lecture) {
  for (const p of lecture.pages) {
    if (!p.pdf) continue;
    const t = await pdfPageTitle(p.pdf.page);
    if (t) p.title = t;
  }
}

/**
 * widgets.js（任意）を読み込む。存在しなければ空のオブジェクト。
 * 構文エラー等で読み込めない場合は { __error } を返し、各ウィジェット位置にエラーを表示する。
 */
async function loadWidgets(base, setting) {
  if (setting === false) return {};
  const url = new URL(typeof setting === 'string' ? setting : 'widgets.js', base);
  let head;
  try {
    head = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
  } catch {
    return {};
  }
  if (!head.ok) return {};
  const v = head.headers.get('last-modified') || head.headers.get('etag') || '';
  try {
    return await import(url.href + (v ? `?v=${encodeURIComponent(v)}` : ''));
  } catch (e) {
    console.error(e);
    return { __error: e };
  }
}
