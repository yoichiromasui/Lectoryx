// =============================================================
// 講義ビューアの起動処理（lecture.html?l=<講義パス>[&v=<版>]）
// 各モジュールの結線、キーボード・スワイプ、保存のタイミング、書き出し／読み込み。
// ダウンロード済みの教材は端末内（offline/<版>/…）から、それ以外は配信元から読み込む。
// =============================================================
import { lecturePathFromUrl, loadLecture, fillPdfTitles, checkPath } from './content/lecture.js';
import { offlineRoot, encodePath, canOpenOnline } from './content/source.js';
import { registerSW, swReady } from './pwa.js';
import { startDiag, diag, diagText, clearDiag } from './diag.js';
import { buildPrintView, removePrintView } from './export/print.js';
import { openStore, requestPersistence, isQuotaError } from './store.js';
import { Settings } from './settings.js';
import { Book } from './book.js';
import { PageView } from './view.js';
import { Toolbar } from './ui/toolbar.js';
import { Overview, Menu, toast } from './ui/panels.js';
import { SWIPE, TOOLBAR_PALM_GUARD_MS } from './config.js';
import { h, escapeHtml, isAppleTouchDevice } from './util.js';

/** KaTeX のフォントを先に読み込む（後から読み込まれて数式の位置がずれるのを防ぐ） */
async function preloadFonts() {
  if (!document.fonts) return;
  const jobs = [];
  document.fonts.forEach((f) => {
    if (/KaTeX/.test(f.family)) jobs.push(f.load().catch(() => {}));
  });
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 4000))]);
}

function showFatal(err) {
  console.error(err);
  document.getElementById('loading')?.remove();
  document.body.appendChild(h('div', { class: 'lw-fatal' },
    h('h2', {}, '講義を開けませんでした'),
    h('p', { html: escapeHtml(err?.message || String(err)) }),
    h('p', {}, h('a', { href: 'index.html' }, 'ライブラリ（教材一覧）へ戻る'))));
}

async function main() {
  const root = document.getElementById('app');
  const stage = document.getElementById('stage');
  const path = lecturePathFromUrl();
  if (!path) {
    location.replace('index.html');
    return;
  }

  registerSW();
  startDiag(`講義 ${path}`);
  const settings = new Settings();
  let lecture, store, source;
  try {
    store = await openStore();
    source = await resolveSource(store, checkPath(path));
    [lecture] = await Promise.all([loadLecture(path, { base: source.base }), preloadFonts()]);
  } catch (e) {
    showFatal(e);
    return;
  }
  document.title = `${lecture.meta.title || lecture.id}`;
  rememberRecent(store, lecture);

  let saved = { meta: null, pages: {} };
  try {
    saved = await store.loadLecture(lecture.id);
  } catch (e) {
    console.error(e);
    toast('保存済みの書き込みを読み込めませんでした', 4000);
  }

  const book = new Book(lecture, saved, store);
  const view = new PageView({ stage, book, lecture, settings });

  // ---- 操作 ----
  const actions = {
    overview: () => { menu.close(); overview.toggle(); },
    menu: (anchor) => { overview.close(); menu.isOpen ? menu.close() : menu.open(anchor); },
    addPage: () => {
      view.addBlankPage(lecture.meta.blankBg || 'none');
      toast(`白紙ページを追加しました（${view.index + 1} ページ目）`);
    },
    clear: () => {
      if (view.clearPage()) toast('書き込みを消去しました（↶ で元に戻せます）');
    },
    exportPdf: () => exportPdf({ view, book, lecture }),
    diag: () => showDiag(view, lecture),
    exportInk: () => exportInk(book, lecture),
    importInk: () => importInk(book, lecture),
    home: async () => {
      try {
        if (view.page) book.setScroll(view.stage.scrollTop / view.scale);
        await book.flush();
      } finally { location.href = 'index.html'; }
    },
  };
  const overview = new Overview({ root, view, book, lecture });
  const menu = new Menu({ root, view, settings, actions });
  const toolbar = new Toolbar({ root, view, settings, actions });
  guardPalm(toolbar.el, view);
  guardPalm(toolbar.handle, view);
  // ペン先のダブルタップで切り替えたとき
  view.on('tool-toggled', (tool) => toast(tool === 'eraser' ? '消しゴム（ペン先のダブルタップで切り替え）' : tool === 'hl' ? '蛍光ペン' : 'ペン', 1200));

  document.getElementById('loading')?.remove();
  // URL の #3 などでページを指定できる（なければ前回のページと位置）
  const hashPage = /^#(\d+)$/.exec(location.hash);
  if (hashPage) view.show(Number(hashPage[1]) - 1);
  else view.show(Math.max(0, book.indexOf(book.meta.lastPage)), { scrollTop: book.meta.lastScroll || 0 });
  if (source.old) toast(`旧版（${new Date(source.info.downloadedAt).toLocaleDateString('ja-JP')} にダウンロードした版）を表示しています`, 5000);
  // 教材の更新で内容が変わった、書き込みのあるページを開いたときに知らせる
  const changed = new Set(source.old ? [] : source.info?.changed || []);
  if (changed.size) {
    const told = new Set();
    const tell = () => {
      const id = view.page?.id;
      if (!changed.has(id) || told.has(id)) return;
      told.add(id);
      toast('このページは教材が更新されています。書き込みがずれている場合は、ライブラリの ⋯ →「旧版で開く」で前の版を表示できます', 7000);
    };
    view.on('page', tell);
    tell();
  }
  window.addEventListener('hashchange', () => {
    const m = /^#(\d+)$/.exec(location.hash);
    if (m && Number(m[1]) - 1 !== view.index) view.show(Number(m[1]) - 1);
  });
  setTimeout(() => view.preloadContents(), 300);
  setTimeout(() => fillPdfTitles(lecture).catch(() => {}), 1500);

  // ---- 保存 ----
  if (!store.persistent) toast('この環境では書き込みを保存できません（プライベートブラウズ等）', 5000);
  let persistAsked = false;
  book.on('saved', () => {
    if (!persistAsked) { persistAsked = true; requestPersistence(); }
  });
  book.on('save-error', (e) => diag('error', `保存の失敗: ${e?.message || e}`));
  book.on('save-error', (e) => toast(isQuotaError(e)
    ? '保存容量が不足して書き込みを保存できません。ライブラリで不要な教材を削除してください'
    : `保存に失敗しました: ${e?.message || e}`, 8000));
  const saveNow = () => {
    if (view.page) book.setScroll(view.stage.scrollTop / view.scale);
    book.flush();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
  window.addEventListener('pagehide', saveNow);

  // ---- ブラウザ既定動作の抑止（ピンチズーム等） ----
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }

  installKeyboard({ view, settings, overview, menu });
  installSwipe({ stage, view, settings });

  // デバッグ・テスト用
  window.__lw = { lecture, book, view, settings, store, exportPdf: (o = {}) => exportPdf({ view, book, lecture, ...o }) };
  document.documentElement.dataset.ready = '1';

  // ?print=1 で開くと PDF 出力（印刷画面）を開く。?print=view は印刷用レイアウトの作成のみ（確認・テスト用）
  const printParam = new URLSearchParams(location.search).get('print');
  if (printParam) setTimeout(() => exportPdf({ view, book, lecture, keep: printParam === 'view' }), 500);
}

/**
 * 教材の読み込み元を決める：ダウンロード済み（かつ Service Worker が動作中）なら端末内の版、
 * そうでなければ配信元。?v=<版> で旧版を指定できる。
 */
async function resolveSource(store, path) {
  const want = new URLSearchParams(location.search).get('v');
  let rec = null;
  try { rec = (await store.getLibrary()).find((r) => r.path === path) || null; } catch { /* 無効 */ }
  const online = () => {
    // 配信元から直接開く（GitHub の非公開リポジトリはトークンが要るので不可。先にダウンロードする）
    if (!canOpenOnline() && !path.startsWith('_')) {
      throw new Error('この教材はまだ iPad にダウンロードされていません。ライブラリで「ダウンロード」してから開いてください。');
    }
    return { base: null, rec, info: null, old: false };
  };
  if (!rec || !swReady()) return online();
  const version = want && rec.versions[want] ? want : rec.current;
  // ファイルが端末から消えていれば配信元から（オンライン時）
  if (typeof caches !== 'undefined' && !(await caches.has('lw-lec-' + version).catch(() => false))) return online();
  return {
    base: offlineRoot(version) + encodePath(path) + '/',
    rec, version, info: rec.versions[version], old: version !== rec.current,
  };
}

/** 最近使った教材（ライブラリに表示） */
async function rememberRecent(store, lecture) {
  try {
    const recent = (await store.kvGet('recent')) || {};
    recent[lecture.id] = { t: Date.now(), path: lecture.path, title: lecture.meta.title || lecture.path };
    const keep = Object.entries(recent).sort((a, b) => b[1].t - a[1].t).slice(0, 30);
    await store.kvSet('recent', Object.fromEntries(keep));
  } catch { /* 無視 */ }
}

/** 動作の記録（不具合の報告用）を表示する */
function showDiag(view, lecture) {
  const ctx = `講義: ${lecture.id} / ${view.index + 1} ページ / ツール ${view.settings.get('tool')}`;
  const text = () => diagText(ctx);
  const pre = h('pre', { class: 'lw-diag-text' }, text());
  const close = () => wrap.remove();
  const wrap = h('div', { class: 'lw-overlay lw-diag', onclick: (e) => { if (e.target === wrap) close(); } },
    h('div', { class: 'lw-diag-panel' },
      h('div', { class: 'lw-diag-head' },
        h('strong', {}, '動作の記録（不具合の報告用）'),
        h('button', { type: 'button', class: 'lw-menu-item', onclick: async () => {
          try { await navigator.clipboard.writeText(text()); toast('コピーしました。そのまま Claude Code などに貼り付けてください'); } catch { toast('コピーできませんでした（文字を長押しして選択してください）'); }
        } }, 'コピー'),
        h('button', { type: 'button', class: 'lw-menu-item', onclick: () => { if (confirm('記録を消去しますか？')) { clearDiag(); pre.textContent = text(); } } }, '消去'),
        h('button', { type: 'button', class: 'lw-menu-item', onclick: close }, '閉じる')),
      h('p', { class: 'lw-diag-note' }, '固まった・タッチが効かなかった直後に開くと、その時刻の記録が残っています（新しい順）。記録はこの iPad の中だけにあり、外部には送られません。'),
      pre));
  document.body.appendChild(wrap);
}

let exporting = false;

/**
 * 書き込み付きの PDF を出力する（印刷用レイアウトを作って印刷画面を開く）。
 * iPad：印刷画面の共有ボタン →「ファイルに保存」、PC：送信先「PDF に保存」。
 */
async function exportPdf({ view, book, lecture, keep = false }) {
  if (exporting) return 0;
  exporting = true;
  const title = document.title;
  try {
    toast('PDF を準備しています…', 60000);
    const { sheets } = await buildPrintView({
      view, book,
      onProgress: (i, n) => toast(`PDF を準備しています… ${i + 1} / ${n}`, 60000),
    });
    document.body.classList.add('lw-printing');
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    document.title = `${lecture.meta.title || lecture.id.replace(/\//g, '_')}_書き込み_${stamp}`;
    toast(isAppleTouchDevice()
      ? '印刷画面の右上の共有ボタン →「ファイルに保存」で PDF になります'
      : '印刷画面の送信先で「PDF に保存」を選んでください', 8000);
    if (keep) return sheets;
    const cleanup = () => {
      window.removeEventListener('afterprint', cleanup);
      removePrintView();
      document.title = title;
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    return sheets;
  } catch (e) {
    console.error(e);
    removePrintView();
    document.title = title;
    toast(`PDF の作成に失敗しました: ${e.message}`, 6000);
    return 0;
  } finally {
    exporting = false;
  }
}

function installKeyboard({ view, settings, overview, menu }) {
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? view.redo() : view.undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); view.redo(); return; }
    if (mod || e.altKey) return;
    switch (key) {
      case 'ArrowRight': case 'PageDown': view.next(); break;
      case 'ArrowLeft': case 'PageUp': view.prev(); break;
      case 'Home': view.show(0); break;
      case 'End': view.show(view.book.length - 1); break;
      case 'Escape': overview.close(); menu.close(); break;
      case 'g': overview.toggle(); break;
      case 'v': settings.set('tool', 'hand'); break;
      case 'p': settings.set('tool', 'pen'); break;
      case 'h': settings.set('tool', 'hl'); break;
      case 'e': settings.set('tool', 'eraser'); break;
      case 'l': settings.set('tool', 'laser'); break;
      case 't': settings.set('tool', 'text'); break;
      default: return;
    }
    e.preventDefault();
  });
}

/** 書いている最中・直後の手のひらがツールバーのボタンに触れても反応しないようにする */
function guardPalm(el, view) {
  let blockedAt = -1e9;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && view.input.penGuard(performance.now(), TOOLBAR_PALM_GUARD_MS)) {
      blockedAt = performance.now();
      diag('palm', 'ツールバーのタッチを無視（ペンで書いている最中・直後）', 1000);
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  el.addEventListener('click', (e) => {
    if (performance.now() - blockedAt < 1000) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

/**
 * 指 1 本の素早い横スワイプでページ送り。
 * グラフ（ウィジェットの表示部）の上でもページを送れる。スライダーなどの操作パネル、グラフ上の
 * ドラッグできる点、動画・埋め込み・リンク・ボタンの上では無効（それぞれの操作を優先）。ペン使用直後も無効。
 */
function installSwipe({ stage, view, settings }) {
  let st = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (st) { st.multi = true; return; }
    if (!settings.get('swipe') || !e.isPrimary || view.input.penGuard()) return;
    if (e.target.closest?.('[data-ink="off"], iframe, video, audio, a, button, input, select, textarea, .lw-text-editor')) return;
    if (typeof e.target.lwWantsPointer === 'function' && e.target.lwWantsPointer(e)) return;
    st = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), multi: false };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    const ok = !st.multi && Math.abs(dx) > SWIPE.minDx && Math.abs(dy) < Math.abs(dx) * SWIPE.maxSlope &&
      performance.now() - st.t < SWIPE.maxMs && !view.input.penGuard();
    st = null;
    if (ok) (dx < 0 ? view.next() : view.prev());
  });
  stage.addEventListener('pointercancel', (e) => { if (st && e.pointerId === st.id) st = null; });
}

function exportInk(book, lecture) {
  const data = book.exportData();
  book.flush();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const name = `ink_${lecture.id.replace(/[/\\]/g, '_')}_${stamp}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  // iPad では共有シート（「ファイルに保存」など）を使う
  if (isAppleTouchDevice() && navigator.canShare) {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch((e) => {
        if (e.name !== 'AbortError') download(blob, name);
      });
      return;
    }
  }
  download(blob, name);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  toast('書き込みを書き出しました');
}

function importInk(book, lecture) {
  const input = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.remove();
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.lecture && data.lecture !== lecture.id &&
          !confirm(`別の講義（${data.lecture}）の書き込みです。この講義に読み込みますか？`)) return;
      if (!confirm('現在の書き込みはすべて置き換えられます。読み込みますか？')) return;
      await book.importData(data);
      location.reload();
    } catch (e) {
      console.error(e);
      toast(`読み込みに失敗しました: ${e.message}`, 5000);
    }
  });
  input.click();
}

main().catch(showFatal);
