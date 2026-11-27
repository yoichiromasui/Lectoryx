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
import { PageButtons } from './ui/pagebuttons.js';
import { Overview, Menu, toast } from './ui/panels.js';
import { SWIPE, TOOLBAR_PALM_GUARD_MS, MAX_ZOOM, PALM_RADIUS } from './config.js';
import { h, escapeHtml, isAppleTouchDevice, clamp } from './util.js';

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
  new PageButtons({ root, view, settings });
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

  // ---- ブラウザ既定動作の抑止（ピンチズーム等。拡大はアプリで行う：installPinch） ----
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }

  installKeyboard({ view, settings, overview, menu });
  installSwipe({ stage, view, settings });
  installPinch({ stage, view });

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
 * 指 1 本の横スワイプでページ送り。
 *   スライド（設定 pageTransition='slide'）：ページが指について横に動き、十分に引っ張るか素早く払うと次のページへ。
 *   すぐ（'instant'）：素早い横スワイプでぱっと切り替わる。
 * グラフ（ウィジェットの表示部）の上でもページを送れる。スライダーなどの操作パネル、グラフ上の
 * ドラッグできる点、動画・埋め込み・リンク・ボタンの上では無効（それぞれの操作を優先）。ペン使用直後も無効。
 *
 * 指の動き・指を離したことはウィンドウ全体で受け取る。iPad の Safari では、ステージの外の要素
 * （授業モードの左下のページ送りボタン・右上のボタンなど）の上で指を離すと、pointerup がステージに
 * 届かないことがある。届かないと「スワイプ中」の状態が残り、以後のスワイプをすべて 2 本目の指と
 * みなして無視してしまう（授業モードの後にスワイプが効かなくなった。2026-11）。
 * 念のため、新しい最初の指が触れたとき・すべての指が離れたときにも、残った状態を捨てる。
 *
 * 縦スクロールとの取り合い：ページが 1 画面より少しでも高い（縦にスクロールできる）と、iPad は
 * 横向きの指の動きでも縦スクロールを始め、スワイプが pointercancel で取り消されて表示が上下に動く
 * （スライダーのあるページで起きた。2026-11）。そこで
 *   ・指が 4px 動いた時点で向きを決め、はっきり縦でなければ touchmove を preventDefault して
 *     縦スクロールを始めさせない（本当に縦に動かしたときは今までどおりスクロールする）
 *   ・それでもスクロールに取られて pointercancel になったら、タッチイベント（スクロール中も届く）で
 *     指を離した位置を見て、十分に横へ動いていればページを送る
 */
function installSwipe({ stage, view, settings }) {
  let st = null;   // スワイプ中の指（Pointer Events）
  let tt = null;   // 同じ指のタッチ { id, x, y, dx, dy, lock: null|'x'|'y', armed, cancelled, multi }
  const slide = () => settings.get('pageTransition') === 'slide' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  // 指の向き：4px 動いた時点で決める。はっきり縦（縦が横の 1.5 倍超）なら 'y'（スクロール）、それ以外は 'x'（スワイプ）。
  // Pointer Events とタッチイベントの先に来た方で決め、もう一方も同じ判定を使う。
  const axisOf = (dx, dy) => (dx * dx + dy * dy < 16 ? null : Math.abs(dy) > Math.abs(dx) * 1.5 ? 'y' : 'x');
  const drop = (why) => {
    if (!st) return;
    st = null;
    view.slideBack();
    diag('swipe', `スワイプの状態を解除（${why}）`, 300);
  };
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if (st && e.isPrimary) drop('指を離したことが届かなかった');   // 最初の指＝ほかに触れている指はない
    if (st) { st.multi = true; view.slideBack(); return; }
    if (!settings.get('swipe') || !e.isPrimary || view.input.penGuard() || view.turning) return;
    if (view.zoom > 1) return;   // 拡大中は指 1 本の横の動きはスクロール（installPinch）
    if (e.target.closest?.('[data-ink="off"], iframe, video, audio, a, button, input, select, textarea, .lw-text-editor')) return;
    if (typeof e.target.lwWantsPointer === 'function' && e.target.lwWantsPointer(e)) return;
    st = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), multi: false, axis: null, dx: 0 };
  });
  window.addEventListener('pointermove', (e) => {
    if (!st || e.pointerId !== st.id || st.multi || !slide() || view.turning) return;
    const dx = e.clientX - st.x;
    const dy = e.clientY - st.y;
    if (!st.axis) st.axis = axisOf(dx, dy);
    if (st.axis !== 'x') return;
    const canGo = dx < 0 ? view.index < view.book.length - 1 : view.index > 0;
    st.dx = canGo ? dx : dx * 0.25;   // 最初・最後のページでは少しだけ動いて戻る
    view.slideTo(st.dx, false);
  });
  window.addEventListener('pointerup', (e) => {
    if (!st || e.pointerId !== st.id) return;
    const s = st;
    st = null;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    const dt = performance.now() - s.t;
    if (slide()) {
      const W = stage.clientWidth;
      const go = s.axis === 'x' && !s.multi && !view.input.penGuard() &&
        (Math.abs(dx) > Math.max(80, W * 0.18) || (Math.abs(dx) > 40 && dt < 300));
      if (go) view.turn(dx < 0 ? 1 : -1);
      else view.slideBack();
      return;
    }
    const ok = !s.multi && Math.abs(dx) > SWIPE.minDx && Math.abs(dy) < Math.abs(dx) * SWIPE.maxSlope &&
      dt < SWIPE.maxMs && !view.input.penGuard();
    if (ok) (dx < 0 ? view.next() : view.prev());
  }, true);
  window.addEventListener('pointercancel', (e) => {
    if (st && e.pointerId === st.id) {
      st = null;
      view.slideBack();
      if (tt && tt.armed) tt.cancelled = true;   // ブラウザがスクロールを始めた → 指を離した位置で判定する
    }
  }, true);

  // ---- タッチイベント（縦スクロールとの取り合い） ----
  stage.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    if (e.touches.length !== 1 || t.touchType === 'stylus') {   // 2 本目の指・Apple Pencil
      if (tt) tt.multi = true;
      return;
    }
    tt = { id: t.identifier, x: t.clientX, y: t.clientY, dx: 0, dy: 0, lock: null, armed: false, cancelled: false, multi: false };
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!tt || tt.multi) return;
    if (e.touches.length !== 1) { tt.multi = true; return; }
    const t = e.touches[0];
    if (t.identifier !== tt.id) return;
    tt.dx = t.clientX - tt.x;
    tt.dy = t.clientY - tt.y;
    if (tt.cancelled) return;
    if (!tt.armed) {
      if (!st) return;   // スワイプの対象でない（操作パネル・ドラッグ点の上など）
      tt.armed = true;
    }
    if (!tt.lock && st) {
      if (!st.axis) st.axis = axisOf(tt.dx, tt.dy);
      tt.lock = st.axis;
    }
    if (tt.lock === 'x' && e.cancelable) e.preventDefault();
  }, { passive: false });
  for (const type of ['touchend', 'touchcancel']) {
    window.addEventListener(type, (e) => {
      if (e.touches.length) return;
      // スクロールに取られたスワイプ：指を離した位置で判定する
      const s = tt;
      tt = null;
      if (s && s.cancelled && !s.multi && type === 'touchend') {
        for (const t of e.changedTouches) {
          if (t.identifier === s.id) { s.dx = t.clientX - s.x; s.dy = t.clientY - s.y; }
        }
        const W = stage.clientWidth;
        if (Math.abs(s.dx) > Math.max(80, W * 0.18) && Math.abs(s.dx) > Math.abs(s.dy) * 1.5 && !view.input.penGuard() && !view.turning) {
          diag('swipe', 'スクロールに取られたスワイプを、指を離した位置で判定してページ送り', 1000);
          view.turn(s.dx < 0 ? 1 : -1);
        }
      }
      // pointerup も pointercancel も届かなかったとき：すべての指が離れたら状態を捨てる
      // （pointerup は touchend より先に届くので、少し待ってから確かめる）
      if (st) {
        const p = st;
        setTimeout(() => { if (st === p) drop('すべての指が離れた'); }, 50);
      }
    }, true);
  }
}

/**
 * 指 2 本のピンチで拡大・縮小（画面に合わせた大きさ 〜 MAX_ZOOM 倍）。
 * ブラウザのピンチズームは使わない（ツールバーやボタンまで拡大され、手書き・グラフ・PDF のキャンバスは
 * 元の解像度のまま引き伸ばされる）。lecture.html の user-scalable=no、#stage の touch-action、
 * gesture イベントの preventDefault で止めてある。
 * 指の間隔が PINCH_START_PX 以上変わったら始める（それまでは 2 本指のスクロールなどブラウザに任せる。
 * 手を置いただけで少し拡大され、スワイプが効かなくなるのを防ぐ）。
 * 指を動かしている間は view.previewZoom（transform だけ。軽い）で、2 本の指の中点の下の点が指についていく。
 * 指を離したら view.setZoom で倍率を確定して描き直す（等倍の近くまで縮めたら等倍に戻す）。
 * 拡大中は指 1 本で上下左右にスクロールし、スワイプのページ送りはしない（ボタン・キーで送る。
 * ページを切り替えると等倍に戻る）。
 * 始めないとき：ペンで書いている最中・直後、手のひら（接触が PALM_RADIUS より大きい・パームとして無視した指）や
 * 書いている指（指で書く ON）がある、操作パネル・入力欄・ボタン・動画などの上、グラフのドラッグ点の上、
 * ページ送りの動きの最中。
 * 指を離したことが届かなくても、新しい指が触れたときに確定する。
 */
const PINCH_START_PX = 16;
function installPinch({ stage, view }) {
  // { a, b: 2 本の指の identifier, d0: 始めの指の間隔, z0: 始めの拡大率, L: 始めの中点の下の論理座標,
  //   m: 今の中点, z: 今の拡大率, on: 拡大を始めたか }
  let pz = null;
  const find = (list, id) => { for (const t of list) if (t.identifier === id) return t; return null; };
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const usable = (t) => {
    const el = t.target;
    if (t.touchType === 'stylus' || !el?.closest || !stage.contains(el)) return false;
    if (view.input.inkTouches.has(t.identifier) || view.input.blockedTouches.has(t.identifier)) return false;
    if (Math.max(t.radiusX || 0, t.radiusY || 0) > PALM_RADIUS) return false;
    if (el.closest('[data-ink="off"], iframe, video, audio, a, button, input, select, textarea, .lw-text-editor')) return false;
    if (typeof el.lwWantsPointer === 'function') {
      try { if (el.lwWantsPointer({ clientX: t.clientX, clientY: t.clientY, pointerType: 'touch' })) return false; } catch { /* 無視 */ }
    }
    return true;
  };
  const finish = () => {
    const p = pz;
    pz = null;
    if (!p || !p.on) return;
    view.setZoom(p.z < 1.05 ? 1 : p.z, { ...p.L, clientX: p.m.x, clientY: p.m.y });
    diag('zoom', `ピンチで ${view.zoom.toFixed(2)} 倍`, 300);
  };
  stage.addEventListener('touchstart', (e) => {
    if (pz && !(find(e.touches, pz.a) && find(e.touches, pz.b))) finish();   // 指を離したことが届かなかった
    if (pz || e.touches.length !== 2) return;   // ピンチ中の 3 本目の指は無視
    const [a, b] = e.touches;
    if (view.turning || view.input.active || view.input.penGuard() || !usable(a) || !usable(b)) return;
    const m = mid(a, b);
    pz = { a: a.identifier, b: b.identifier, d0: Math.max(dist(a, b), 1), z0: view.zoom, L: view.toLogical(m.x, m.y), m, z: view.zoom, on: false };
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!pz) return;
    const a = find(e.touches, pz.a);
    const b = find(e.touches, pz.b);
    if (!a || !b) return;
    if (!pz.on) {
      if (Math.abs(dist(a, b) - pz.d0) < PINCH_START_PX) return;
      pz.on = true;
      // ここまでに 2 本指でスクロールしていたら、今の中点を基準にし直す
      const m = mid(a, b);
      pz.L = view.toLogical(m.x, m.y);
      pz.d0 = dist(a, b);
    }
    if (e.cancelable) e.preventDefault();   // 2 本指でブラウザにスクロールさせない
    pz.m = mid(a, b);
    pz.z = clamp(pz.z0 * dist(a, b) / pz.d0, 1, MAX_ZOOM);
    view.previewZoom(pz.z, { ...pz.L, clientX: pz.m.x, clientY: pz.m.y });
  }, { passive: false });
  for (const type of ['touchend', 'touchcancel']) {
    window.addEventListener(type, (e) => {
      if (pz && !(find(e.touches, pz.a) && find(e.touches, pz.b))) finish();
    }, true);
  }
  view.on('page', () => { pz = null; });   // ページを切り替えた（表示は等倍に戻っている）
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
