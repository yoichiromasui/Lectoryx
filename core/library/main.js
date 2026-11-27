// =============================================================
// 教材ライブラリ（index.html）
//   ・科目ごと・年度ごとの教材一覧、最近使った教材
//   ・配信元（GitHub Pages の URL、または GitHub の非公開リポジトリ）から教材一覧を取得し、
//     新しい教材・更新された教材を検出
//   ・ダウンロード（個別・科目ごと・すべて）、進捗、失敗時の再試行、端末からの削除
//   ・アプリ本体の更新（ユーザーが押したときだけ）、保存容量、バックアップと復元、配信元の設定
// オフラインでも、端末に保存した一覧とダウンロード済みの教材で動作する。
// =============================================================
import { h, isStandalone, isAppleTouchDevice } from '../util.js';
import { openStore, storageEstimate, requestPersistence, isQuotaError } from '../store.js';
import { registerSW, swSupported, waitForController, appStatus, checkAppUpdate, applyAppUpdate } from '../pwa.js';
import {
  getSource, setSource, clearGithubSource, contentRoot, DEFAULT_CONTENT_ROOT, DEFAULT_BRANCH, encodePath, canOpenOnline,
} from '../content/source.js';
import {
  fetchCatalog, cachedCatalog, testSource, statusOf, Downloader, removeLecture, removeVersion, cleanupCaches, fmtBytes, cachesAvailable, LEC_CACHE,
} from './download.js';
import { createBackup, inspectBackup, restoreBackup } from './backup.js';
import { saveFile, pickFile, dateStamp } from '../ui/files.js';
import { startDiag, diag, diagText } from '../diag.js';
import { capturePairing, isSafariLike } from '../exercise/native.js';

const S = {
  store: null,
  catalog: null,          // { root, fetchedAt, data }
  catalogError: null,
  checking: false,
  records: new Map(),
  recent: {},
  ink: {},                // 講義 ID → 書き込みのあるページ数
  seen: new Set(),        // 一覧で見たことのある講義（新着の判定）
  filter: localGet('lw.lib.filter') || 'all',
  year: localGet('lw.lib.year') || 'all',
  app: null,
  dl: null,
  appConfig: {},          // app-config.json（アプリだけを公開した場合 { contentType:'github' }）
  openAfter: null,        // ダウンロードが終わったら開く講義
  srcMode: null,          // 設定画面で選んでいる配信元の種類
};

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 無効 */ } }

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------
// 起動
// ---------------------------------------------------------------
async function main() {
  if (location.protocol === 'file:') {
    $('lib-list').appendChild(h('div', { class: 'lib-banner err' },
      'file:// で開かれています。プロジェクトのフォルダで python tools/serve.py を実行し、表示された URL を開いてください。'));
    return;
  }
  registerSW().then((reg) => {
    if (!reg) return;
    // 新しい版のダウンロードが終わったら「アプリの更新」を表示（起動と同時に始まっている場合も）
    const track = (w) => w?.addEventListener('statechange', () => {
      if (['installed', 'activated', 'redundant'].includes(w.state)) refreshApp();
    });
    track(reg.installing);
    reg.addEventListener('updatefound', () => track(reg.installing));
    if (reg.waiting) refreshApp();
  });
  startDiag('ライブラリ');
  // Lectoryx ローカル実行ツール（PC の Julia）が開いたペアリング用 URL（#lectoryx=<port>.<token>）
  if (capturePairing()) {
    // Safari は https のページから PC の Julia（127.0.0.1）への接続を禁止しているので、ここで結び付けても使えない
    const safari = isSafariLike() && location.protocol === 'https:';
    setTimeout(() => toast(safari
      ? 'Safari では PC の Julia を使えません。実行ツールのウィンドウの「ペアリング用 URL」を Chrome・Edge・Firefox で開いてください'
      : 'PC の Julia とつなぎました。演習のある講義を開いて「開く」を押してください', safari ? 12000 : 7000), 300);
  }
  S.store = await openStore();
  S.appConfig = await fetch('app-config.json').then((r) => (r.ok ? r.json() : {}), () => ({})).catch(() => ({}));
  S.dl = new Downloader(S.store);
  S.dl.on('change', () => render());
  S.dl.on('progress', (id, job) => updateProgress(id, job));
  S.dl.on('done', onDownloaded);
  S.dl.on('failed', (id, err) => {
    if (S.openAfter === id) S.openAfter = null;
    toast(isQuotaError(err) ? err.message : `ダウンロードに失敗しました：${err.message}`, 6000);
  });

  await loadState();
  render();
  bindHeader();
  window.addEventListener('online', () => { render(); refreshCatalog({ quiet: true }); });
  window.addEventListener('offline', () => render());
  cleanupCaches(S.store, S.dl.busyVersions).catch(() => {});
  refreshApp();
  if (swSupported() && !navigator.serviceWorker.controller) waitForController().then(() => { render(); refreshApp(); });
  if (navigator.onLine !== false && !needsSetup()) refreshCatalog({ quiet: true });
  window.__lib = { S, refreshCatalog, download: (ids) => S.dl.enqueue(entriesFor(ids)), loadState, render };
  document.documentElement.dataset.ready = '1';
}

async function loadState() {
  const t0 = performance.now();
  try { await loadStateInner(); } finally {
    const ms = performance.now() - t0;
    if (ms > 300) diag('page', `ライブラリの読み込み ${Math.round(ms)}ms`);
  }
}

async function loadStateInner() {
  const st = S.store;
  const [cat, recs, recent, ink, seen] = await Promise.all([
    cachedCatalog(st), st.getLibrary(), st.kvGet('recent'), st.inkSummary(), st.kvGet('seen'),
  ]);
  S.catalog = cat;
  // iPadOS が保存領域を整理してファイルだけ消えた場合は「未ダウンロード」として扱う
  if (cachesAvailable()) {
    for (const r of recs) r._missing = !(await caches.has(LEC_CACHE(r.current)));
  }
  S.records = new Map(recs.map((r) => [r.id, r]));
  S.recent = recent || {};
  S.ink = ink || {};
  S.seen = new Set(seen || []);
}

async function refreshApp() {
  S.app = await appStatus();
  renderBanners();
  const p = $('lib-settings');
  if (p?.isConnected && !p.contains(document.activeElement)) renderSettings();
}

/** 配信元の設定が必要か（アプリだけを公開していて、GitHub のリポジトリがまだ設定されていない） */
function needsSetup() {
  return S.appConfig?.contentType === 'github' && getSource().type !== 'github';
}

let checkingPromise = null;

/** 教材一覧を取得（取得中に呼ばれたら、その完了を待つ） */
function refreshCatalog(o = {}) {
  if (!checkingPromise) checkingPromise = doRefreshCatalog(o).finally(() => { checkingPromise = null; });
  return checkingPromise;
}

async function doRefreshCatalog({ quiet = false } = {}) {
  S.checking = true;
  renderHeader();
  const before = new Map((S.catalog?.data.lectures || []).map((e) => [e.id, e.version]));
  const hadCatalog = !!S.catalog;
  try {
    S.catalog = await fetchCatalog(S.store);
    S.catalogError = null;
    const list = S.catalog.data.lectures;
    const added = hadCatalog ? list.filter((e) => !before.has(e.id)).length : 0;
    const updates = list.filter((e) => statusOf(e, S.records.get(e.id), null) === 'update').length;
    if (!hadCatalog && !S.seen.size) {
      // 初めての取得：すべて「見た」ことにする（全部が新着にならないように）
      S.seen = new Set(list.map((e) => e.id));
      await S.store.kvSet('seen', [...S.seen]);
    }
    if (!quiet || added || updates) {
      const parts = [];
      if (added) parts.push(`新しい教材 ${added} 件`);
      if (updates) parts.push(`更新あり ${updates} 件`);
      toast(parts.length ? `教材一覧を確認しました（${parts.join('・')}）` : '教材一覧は最新です');
    }
  } catch (e) {
    S.catalogError = e;
    if (!quiet) toast(`教材一覧を取得できません：${e.message}（ダウンロード済みの教材は使えます）`, 5000);
  } finally {
    S.checking = false;
    render();
  }
}

// ---------------------------------------------------------------
// 一覧のデータ
// ---------------------------------------------------------------
function items() {
  const map = new Map();
  for (const e of S.catalog?.data.lectures || []) map.set(e.id, { id: e.id, entry: e, rec: S.records.get(e.id) || null, inCatalog: true });
  for (const r of S.records.values()) {
    if (map.has(r.id)) continue;
    const entry = r.versions[r.current]?.entry;
    if (entry) map.set(r.id, { id: r.id, entry, rec: r, inCatalog: false });
  }
  for (const it of map.values()) {
    it.job = S.dl.jobs.get(it.id) || null;
    it.status = statusOf(it.inCatalog ? it.entry : null, it.rec, it.job);
    it.isNew = it.inCatalog && !it.rec && S.catalog && !S.seen.has(it.id);
  }
  return [...map.values()];
}

function entriesFor(ids) {
  const list = S.catalog?.data.lectures || [];
  return ids.map((id) => list.find((e) => e.id === id)).filter(Boolean);
}

const downloaded = (it) => !!it.rec && !it.rec._missing;
const canFetch = (it) => it.inCatalog && ['none', 'update', 'failed'].includes(it.status);

// ---------------------------------------------------------------
// 描画
// ---------------------------------------------------------------
function render() {
  renderHeader();
  renderBanners();
  const root = $('lib-list');
  root.textContent = '';
  const all = items();
  $('lib-title').textContent = S.catalog?.data.title || 'My Lectures';
  document.title = 'Lectoryx';
  $('lib-sub').textContent = S.catalog?.data.subtitle || '';

  if (!all.length) {
    if (needsSetup() || S.catalogError?.code === 'no-catalog') {
      root.appendChild(h('div', { class: 'lib-setup' },
        h('h2', {}, '教材の配信元を設定してください'),
        h('p', {}, '教材を置いた GitHub のリポジトリ（非公開）と、読み取り用のアクセストークンを設定すると、教材の一覧が表示されます。設定はこの iPad の中だけに保存されます。'),
        h('button', { type: 'button', class: 'lib-btn primary', onclick: () => openSettings('source') }, '配信元を設定する')));
      return;
    }
    root.appendChild(h('div', { class: 'lib-empty' },
      S.catalogError ? h('div', {}, h('p', {}, `教材一覧を取得できませんでした：${S.catalogError.message}`),
        h('button', { type: 'button', class: 'lib-btn', onclick: () => openSettings('source') }, '配信元の設定を開く'))
        : S.checking ? '教材一覧を取得しています…' : '教材がありません。「更新を確認」を押してください。'));
    return;
  }

  // 最近使った教材
  const recent = Object.entries(S.recent)
    .map(([id, r]) => ({ ...r, id, it: all.find((x) => x.id === id) }))
    .filter((r) => r.it).sort((a, b) => b.t - a.t).slice(0, 4);
  if (recent.length) {
    root.appendChild(h('h2', { class: 'lib-h2' }, '最近使った教材'));
    root.appendChild(h('div', { class: 'lib-recent' }, recent.map((r) => h('button', {
      type: 'button', class: 'lib-card', onclick: () => openLecture(r.it),
    },
    h('div', { class: 'lib-card-course' }, r.it.entry.course || ''),
    h('div', { class: 'lib-card-title' }, r.it.entry.title),
    h('div', { class: 'lib-card-meta' }, `${fmtDate(r.t)} に使用`, badge(r.it, true))))));
  }

  // 絞り込み
  const years = [...new Set(all.map((x) => x.entry.year).filter((y) => y != null))].sort((a, b) => b - a);
  if (S.year !== 'all' && !years.includes(Number(S.year))) S.year = 'all';
  const chip = (label, on, fn) => h('button', { type: 'button', class: 'lib-chip' + (on ? ' on' : ''), onclick: fn }, label);
  root.appendChild(h('div', { class: 'lib-filters' },
    chip('すべて', S.filter === 'all', () => setFilter('all')),
    chip('ダウンロード済み', S.filter === 'downloaded', () => setFilter('downloaded')),
    years.length > 1 ? h('span', { class: 'lib-sep' }) : null,
    years.length > 1 ? chip('全年度', S.year === 'all', () => setYear('all')) : null,
    years.length > 1 ? years.map((y) => chip(`${y} 年度`, String(S.year) === String(y), () => setYear(String(y)))) : null));

  let list = all;
  if (S.filter === 'downloaded') list = list.filter(downloaded);
  if (S.year !== 'all') list = list.filter((x) => String(x.entry.year) === String(S.year));

  // 科目ごと
  const order = S.catalog?.data.courses || [];
  const groups = new Map();
  for (const it of list) {
    const c = it.entry.course || 'その他';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(it);
  }
  const names = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b, 'ja');
  });
  if (!names.length) root.appendChild(h('div', { class: 'lib-empty' }, '該当する教材はありません。'));
  for (const name of names) {
    const its = groups.get(name);
    const fetchable = its.filter(canFetch);
    root.appendChild(h('section', { class: 'lib-course' },
      h('div', { class: 'lib-course-head' },
        h('h2', { class: 'lib-h2' }, name, h('span', { class: 'lib-count' }, `${its.length} 件`)),
        fetchable.length ? h('button', {
          type: 'button', class: 'lib-btn small', disabled: !online(),
          onclick: () => S.dl.enqueue(fetchable.map((x) => x.entry)),
        }, `この科目をすべてダウンロード（${fetchable.length}）`) : null),
      h('div', { class: 'lib-rows' }, its.map(row))));
  }
}

function row(it) {
  const e = it.entry;
  const meta = [e.lecture, e.date, e.pages ? `${e.pages} ページ` : null, fmtBytes(e.size),
    e.updated ? `更新 ${fmtDate(e.updated)}` : null].filter(Boolean).join(' ・ ');
  const ink = S.ink[it.id];
  const old = it.rec ? Object.keys(it.rec.versions).filter((v) => v !== it.rec.current) : [];
  const el = h('div', { class: `lib-row st-${it.status}`, 'data-id': it.id },
    h('button', { type: 'button', class: 'lib-open', onclick: () => openLecture(it) },
      h('div', { class: 'lib-row-title' }, e.title, it.isNew ? h('span', { class: 'lib-new' }, '新着') : null),
      h('div', { class: 'lib-row-meta' }, meta),
      h('div', { class: 'lib-row-meta2' },
        ink ? `✎ 書き込み ${ink} ページ` : '',
        old.length ? `　旧版 ${old.length}` : '',
        !it.inCatalog && it.rec ? '　（配信元の一覧にありません）' : '',
        it.rec?._missing ? '　端末から教材ファイルが消えています。ダウンロードし直してください（書き込みは残っています）' : '',
        it.status === 'failed' && it.job?.error ? h('span', { class: 'lib-err' }, `　${it.job.error.message}`) : '')),
    h('div', { class: 'lib-state' }, badge(it)),
    action(it),
    h('button', { type: 'button', class: 'lib-more', title: 'その他', onclick: (ev) => rowMenu(it, ev.currentTarget) }, '⋯'));
  return el;
}

function badge(it, small = false) {
  const st = it.status;
  const cls = 'lib-badge' + (small ? ' small' : '');
  if (st === 'downloading') {
    const j = it.job;
    const pct = j.size ? Math.floor((100 * j.loaded) / j.size) : 0;
    return h('div', { class: 'lib-progress', 'data-progress': it.id },
      h('div', { class: 'lib-bar' }, h('span', { style: { width: pct + '%' } })),
      h('div', { class: 'lib-pct' }, `${pct}%`));
  }
  const map = {
    none: ['未ダウンロード', 'gray'], queued: ['待機中', 'gray'], failed: ['失敗', 'red'],
    ready: ['オフライン可', 'green'], update: ['新しい版あり', 'orange'],
  };
  const [label, color] = map[st] || ['', 'gray'];
  return h('span', { class: `${cls} ${color}` }, st === 'ready' ? '✓ ' + label : label);
}

function action(it) {
  const off = !online();
  const btn = (label, fn, cls = '') => h('button', { type: 'button', class: `lib-btn ${cls}`, disabled: off, onclick: fn }, label);
  if (it.status === 'none') return btn('ダウンロード', () => S.dl.enqueue([it.entry]), 'primary');
  if (it.status === 'update') return btn('更新', () => confirmUpdate(it), 'primary');
  if (it.status === 'failed') return btn('再試行', () => S.dl.enqueue([it.entry]));
  return h('span', { class: 'lib-act-space' });
}

function updateProgress(id, job) {
  const el = document.querySelector(`[data-progress="${CSS.escape(id)}"]`);
  if (!el) { render(); return; }
  const pct = job.size ? Math.floor((100 * job.loaded) / job.size) : 0;
  el.querySelector('.lib-bar span').style.width = pct + '%';
  el.querySelector('.lib-pct').textContent = `${pct}%`;
}

function renderHeader() {
  const b = $('lib-refresh');
  if (!b) return;
  b.disabled = S.checking || !online() || needsSetup();
  b.textContent = S.checking ? '確認中…' : '更新を確認';
  const all = $('lib-all');
  const n = S.catalog ? items().filter(canFetch).length : 0;
  all.hidden = !n;
  all.disabled = !online();
  all.textContent = `すべてダウンロード（${n}）`;
}

function renderBanners() {
  const box = $('lib-banners');
  if (!box) return;
  box.textContent = '';
  const add = (cls, ...c) => box.appendChild(h('div', { class: 'lib-banner ' + cls }, ...c));
  if (!window.isSecureContext) {
    add('warn', 'この接続（http）では、教材のダウンロードとオフライン利用ができません。GitHub Pages の https のアドレス（または localhost）で開いてください。');
  } else if (!swSupported()) {
    add('warn', 'このブラウザはオフライン機能に対応していません。');
  } else if (S.app && !S.app.ready) {
    add('info', 'オフラインで使う準備をしています…（初回のみ。完了するまでこの画面を開いたままにしてください）');
  }
  if (S.catalog?.data.demo && getSource().type === 'url') {
    add('info', h('span', {}, '公開デモの教材を表示しています。自分の教材（非公開リポジトリ）を使うには、⋯ →「教材の配信元」で GitHub のリポジトリとアクセストークンを設定してください。'),
      h('button', { type: 'button', class: 'lib-btn small', onclick: () => openSettings('source') }, '設定する'));
  }
  if (!online()) add('info', 'オフラインです。ダウンロード済みの教材を使えます。');
  else if (S.catalogError && S.catalog) add('info', `教材一覧を更新できませんでした（${S.catalogError.message}）。前回取得した一覧を表示しています。`);
  if (S.app?.updateAvailable) {
    add('update', h('span', {}, 'アプリの新しい版があります。授業の前後など、都合のよいときに更新してください。'),
      h('button', { type: 'button', class: 'lib-btn primary', onclick: doAppUpdate }, 'アプリを更新'));
  }
  if (isAppleTouchDevice() && !isStandalone() && window.isSecureContext && !localGet('lw.lib.hideInstall')) {
    add('info', h('span', {}, 'ホーム画面に追加すると、アプリとして全画面で使えます（共有ボタン →「ホーム画面に追加」）。追加したら、以後はホーム画面のアイコンから起動してください（Safari のタブとは保存場所が別です）。'),
      h('button', { type: 'button', class: 'lib-btn small', onclick: () => { localSet('lw.lib.hideInstall', '1'); renderBanners(); } }, '閉じる'));
  }
}

function setFilter(f) { S.filter = f; localSet('lw.lib.filter', f); render(); }
function setYear(y) { S.year = y; localSet('lw.lib.year', y); render(); }

const online = () => navigator.onLine !== false;

function bindHeader() {
  $('lib-refresh').addEventListener('click', () => refreshCatalog());
  $('lib-all').addEventListener('click', () => {
    const list = items().filter(canFetch).map((x) => x.entry);
    if (list.length) S.dl.enqueue(list);
  });
  $('lib-menu').addEventListener('click', openSettings);
}

// ---------------------------------------------------------------
// 操作
// ---------------------------------------------------------------
async function markSeen(id) {
  if (S.seen.has(id)) return;
  S.seen.add(id);
  await S.store.kvSet('seen', [...S.seen]).catch(() => {});
}

function openLecture(it, version) {
  const notHere = !it.rec || it.rec._missing;
  if (notHere && !online()) {
    toast('オフラインです。この教材はダウンロードしていないので開けません', 4000);
    return;
  }
  if (notHere && !canOpenOnline()) {
    // 非公開リポジトリの教材は、ダウンロードしてから開く
    if (!it.inCatalog) return;
    S.openAfter = it.id;
    S.dl.enqueue([it.entry]);
    toast('ダウンロードしてから開きます…', 4000);
    return;
  }
  if (it.rec && !navigator.serviceWorker?.controller && !online()) {
    toast('オフラインの準備が完了していません', 4000);
    return;
  }
  markSeen(it.id);
  const q = `l=${encodePath(it.entry.path)}` + (version ? `&v=${version}` : '');
  location.href = `lecture.html?${q}`;
}

async function onDownloaded(id, r) {
  S.records.set(id, r.rec);
  markSeen(id);
  const title = r.rec.versions[r.rec.current].entry.title;
  if (r.keptOld) {
    toast(`「${title}」を更新しました。書き込みのある ${r.changed.length} ページの内容が変わったため、旧版も残しています（⋯ →「旧版で開く」）`, 9000);
  } else if (r.updated) {
    toast(`「${title}」を更新しました`);
  } else {
    toast(`「${title}」をダウンロードしました（オフラインで使えます）`);
  }
  render();
  if (S.openAfter === id) {
    S.openAfter = null;
    const it = items().find((x) => x.id === id);
    if (it) openLecture(it);
  }
}

function confirmUpdate(it) {
  const ink = S.ink[it.id];
  if (ink && !confirm(`「${it.entry.title}」を新しい版に更新します。\n\n書き込みはそのまま残ります。書き込みのあるページの内容が変わっていた場合は、旧版も残すので、旧版で開いて確認できます。`)) return;
  S.dl.enqueue([it.entry]);
}

async function rowMenu(it, anchor) {
  const acts = [];
  acts.push({ label: '開く', fn: () => openLecture(it) });
  if (it.rec) {
    for (const v of Object.keys(it.rec.versions).filter((x) => x !== it.rec.current)) {
      const d = new Date(it.rec.versions[v].downloadedAt).toLocaleDateString('ja-JP');
      acts.push({ label: `旧版で開く（${d} にダウンロード）`, fn: () => openLecture(it, v) });
    }
  }
  if (canFetch(it)) acts.push({ label: it.status === 'update' ? '新しい版に更新' : 'ダウンロード', fn: () => S.dl.enqueue([it.entry]), disabled: !online() });
  if (it.rec) {
    for (const v of Object.keys(it.rec.versions).filter((x) => x !== it.rec.current)) {
      const d = new Date(it.rec.versions[v].downloadedAt).toLocaleDateString('ja-JP');
      acts.push({ label: `旧版（${d}）を端末から削除`, danger: true, fn: () => deleteOld(it, v) });
    }
    acts.push({ label: 'この教材を端末から削除…', danger: true, fn: () => deleteLecture(it) });
  } else if (S.ink[it.id]) {
    acts.push({ label: 'この教材の書き込みを削除…', danger: true, fn: () => deleteInk(it) });
  }
  sheet(it.entry.title, acts, anchor);
}

async function deleteOld(it, v) {
  if (!confirm('旧版を端末から削除しますか？（書き込みは消えません）')) return;
  await removeVersion(S.store, it.id, v);
  await loadState();
  render();
}

async function deleteLecture(it) {
  if (!confirm(`「${it.entry.title}」を端末から削除しますか？\n\n書き込みは残ります。もう一度ダウンロードすれば元どおり使えます。`)) return;
  let ink = false;
  if (S.ink[it.id]) {
    ink = confirm(`書き込み（${S.ink[it.id]} ページ）も削除しますか？\n\n［OK］書き込みも削除（元に戻せません）\n［キャンセル］書き込みは残す`);
  }
  await removeLecture(S.store, it.id, { ink });
  await loadState();
  render();
  toast(ink ? '教材と書き込みを削除しました' : '教材を削除しました（書き込みは残っています）');
}

async function deleteInk(it) {
  if (!confirm(`「${it.entry.title}」の書き込み（${S.ink[it.id]} ページ）を削除しますか？元に戻せません。`)) return;
  await S.store.clearLecture(it.id);
  await loadState();
  render();
}

async function doAppUpdate() {
  if (!confirm('アプリを新しい版に更新します。\n\n書き込みとダウンロードした教材はそのまま残ります。授業中でなければ［OK］を押してください。')) return;
  toast('更新しています…', 10000);
  await applyAppUpdate();
}

// ---------------------------------------------------------------
// 設定・バックアップ
// ---------------------------------------------------------------
async function openSettings(focus) {
  closeModal();
  const panel = h('div', { class: 'lib-modal-panel', id: 'lib-settings' });
  const wrap = h('div', { class: 'lib-modal', onclick: (e) => { if (e.target === wrap) closeModal(); } }, panel);
  document.body.appendChild(wrap);
  S.srcMode = null;
  await renderSettings();
  if (focus === 'source') $('lib-sec-source')?.scrollIntoView({ block: 'start' });
}

function closeModal() { document.querySelector('.lib-modal')?.remove(); }

async function renderSettings() {
  const p = $('lib-settings');
  if (!p) return;
  const est = await storageEstimate();
  const recs = [...S.records.values()];
  const matBytes = recs.reduce((s, r) => s + Object.values(r.versions).reduce((a, v) => a + (v.bytes || 0), 0), 0);
  const app = S.app || {};
  const sec = (title, ...c) => h('section', { class: 'lib-sec' }, h('h3', {}, title), ...c);
  const btn = (label, fn, cls = '') => h('button', { type: 'button', class: 'lib-btn ' + cls, onclick: fn }, label);
  p.textContent = '';
  p.append(
    h('div', { class: 'lib-modal-head' }, h('h2', {}, '設定・バックアップ'), btn('閉じる', closeModal, 'small')),
    sec('保存容量',
      h('p', {}, est ? `使用中 ${fmtBytes(est.usage)}（上限の目安 ${fmtBytes(est.quota)}）` : '使用量を取得できません'),
      h('p', { class: 'muted' }, `ダウンロードした教材 ${recs.length} 件・${fmtBytes(matBytes)}`),
      est && !est.persisted ? h('p', { class: 'muted' }, '容量が不足したとき、ブラウザが自動でデータを削除する可能性があります。定期的にバックアップしてください。',
        btn('削除されないよう依頼する', async () => { const ok = await requestPersistence(); toast(ok ? '許可されました' : '許可されませんでした（ホーム画面から起動すると許可されやすくなります）'); renderSettings(); }, 'small')) : null,
      est?.persisted ? h('p', { class: 'muted' }, '✓ 自動では削除されない設定です') : null),
    sec('バックアップ',
      h('p', { class: 'muted' }, '書き込みはこの iPad の中だけに保存されています。iPad の故障・データの削除に備えて、学期中は定期的にバックアップしてください（「ファイル」アプリや iCloud Drive に保存）。'),
      h('div', { class: 'lib-btns' },
        btn('すべてをバックアップ（教材＋書き込み .zip）', () => doBackup(true), 'primary'),
        btn('書き込みだけバックアップ（.json）', () => doBackup(false)),
        btn('バックアップから復元…', doRestore))),
    sourceSection(sec, btn),
    sec('アプリ',
      h('p', {}, !app.supported ? 'オフライン機能：使用できません（https で開いてください）'
        : app.ready ? `オフライン機能：有効 ✓　版 ${app.current || '-'}${app.dev ? '（開発用）' : ''}` : 'オフライン機能：準備中'),
      app.updateAvailable ? h('p', {}, `新しい版 ${app.latest || ''} があります。`, btn('アプリを更新', doAppUpdate, 'primary small')) : null,
      app.supported ? btn('アプリの更新を確認', async () => {
        toast('確認しています…');
        S.app = await checkAppUpdate();
        renderBanners();
        renderSettings();
        toast(S.app.updateAvailable ? '新しい版があります' : 'アプリは最新です');
      }, 'small') : null,
      h('p', { class: 'muted' }, 'アプリや教材は自動では更新されません（授業中に変わらないように）。更新はこの画面から行います。'),
      btn('動作の記録（不具合の報告用）', () => {
        const text = diagText('画面: ライブラリ');
        sheet('動作の記録', [{ label: 'コピーする（Claude Code などに貼り付けて報告）', fn: async () => {
          try { await navigator.clipboard.writeText(text); toast('コピーしました'); } catch { toast('コピーできませんでした'); }
        } }]);
      }, 'small')),
    sec('Lectoryx について',
      h('div', { class: 'lib-about' },
        h('img', { src: 'assets/icon.svg', alt: '', width: 56, height: 56 }),
        h('div', {},
          h('div', { class: 'lib-about-name' }, 'Lectoryx'),
          h('div', { class: 'lib-about-tag' }, 'Beyond static lectures.'),
          h('div', { class: 'lib-about-sub' }, 'Lecture × Laboratory × Experience'))),
      h('p', {}, '手書きの書き込み、動的な教材、数値実験（シミュレーション）を 1 つの授業環境にまとめた講義アプリです。'),
      h('p', { class: 'muted' }, 'Lectoryx is an interactive lecture platform that seamlessly integrates handwritten annotations, dynamic visualizations, and live simulations into a single teaching environment.')),
  );
}

/** 設定画面：教材の配信元（公開 URL ／ GitHub の非公開リポジトリ） */
function sourceSection(sec, btn) {
  const cur = getSource();
  const mode = S.srcMode || (cur.type === 'github' || S.appConfig?.contentType === 'github' ? 'github' : 'url');
  const seg = h('div', { class: 'lib-seg' },
    [['github', 'GitHub（非公開リポジトリ）'], ['url', '公開 URL（GitHub Pages など）']].map(([m, label]) => h('button', {
      type: 'button', class: 'lib-seg-btn' + (m === mode ? ' on' : ''),
      onclick: () => { S.srcMode = m; renderSettings(); },
    }, label)));
  const result = h('p', { class: 'lib-test' });
  const apply = async (src) => {
    try {
      setSource(src);
    } catch (e) {
      result.textContent = e.message;
      result.className = 'lib-test err';
      return;
    }
    S.catalog = await cachedCatalog(S.store);
    S.catalogError = null;
    closeModal();
    render();
    refreshCatalog();
  };
  const test = async (src) => {
    result.textContent = '接続を確認しています…';
    result.className = 'lib-test';
    try {
      if (src.type === 'github') {
        if (!src.token && cur.type === 'github') src.token = cur.token;
        if (!/^[\w.-]+\/[\w.-]+$/.test(src.repo)) throw new Error('リポジトリは「ユーザー名/リポジトリ名」の形で入力してください');
        if (!src.token) throw new Error('アクセストークンを入力してください');
        src = { ...src, branch: src.branch || DEFAULT_BRANCH, api: cur.api || 'https://api.github.com' };
      }
      const n = await testSource(src);
      result.textContent = `✓ 接続できました（教材 ${n} 件）`;
      result.className = 'lib-test ok';
    } catch (e) {
      result.textContent = `✗ ${e.message}`;
      result.className = 'lib-test err';
    }
  };
  if (mode === 'github') {
    const gh = cur.type === 'github' ? cur : null;
    const repo = h('input', { type: 'text', class: 'lib-input', value: gh?.repo || '', placeholder: 'ユーザー名/リポジトリ名', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' });
    const branch = h('input', { type: 'text', class: 'lib-input', value: gh?.branch || DEFAULT_BRANCH, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' });
    const token = h('input', { type: 'password', class: 'lib-input', value: '', placeholder: gh ? '設定済み（変更するときだけ入力）' : 'github_pat_…', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' });
    const val = () => ({ type: 'github', repo: repo.value.trim(), branch: branch.value.trim(), token: token.value.trim() });
    return h('section', { class: 'lib-sec', id: 'lib-sec-source' }, h('h3', {}, '教材の配信元'), seg,
      h('p', { class: 'muted' }, '教材を置いた非公開リポジトリの dist ブランチ（GitHub Actions が作成）から、GitHub API で取得します。アクセストークンは「Fine-grained」で、このリポジトリだけ・Contents の読み取りのみを許可したものを使ってください（作り方は README）。トークンはこの iPad の中だけに保存し、バックアップにも含めません。'),
      h('label', { class: 'lib-label' }, 'リポジトリ', repo),
      h('label', { class: 'lib-label' }, 'ブランチ', branch),
      h('label', { class: 'lib-label' }, 'アクセストークン', token),
      result,
      h('div', { class: 'lib-btns' },
        btn('接続を確認', () => test(val())),
        btn('保存して一覧を取得', () => apply(val()), 'primary'),
        gh ? btn('トークンを削除', () => {
          if (!confirm('この iPad に保存したアクセストークンを削除しますか？（ダウンロード済みの教材と書き込みはそのまま使えます）')) return;
          clearGithubSource();
          S.srcMode = 'github';
          renderSettings();
          render();
        }, 'small') : null));
  }
  const input = h('input', { type: 'url', class: 'lib-input', value: cur.type === 'url' ? cur.url : contentRoot(), placeholder: DEFAULT_CONTENT_ROOT, spellcheck: 'false', autocapitalize: 'off' });
  return h('section', { class: 'lib-sec', id: 'lib-sec-source' }, h('h3', {}, '教材の配信元'), seg,
    h('p', { class: 'muted' }, '教材一覧（catalog.json）がある URL。既定はアプリと一緒に公開しているデモ教材です。授業の教材（非公開リポジトリ）は「GitHub（非公開リポジトリ）」で設定します。'),
    input, result,
    h('div', { class: 'lib-btns' },
      btn('接続を確認', () => test({ type: 'url', url: input.value.trim() || DEFAULT_CONTENT_ROOT })),
      btn('保存して一覧を取得', () => apply({ type: 'url', url: input.value.trim() }), 'primary'),
      btn('既定に戻す', () => { input.value = DEFAULT_CONTENT_ROOT; }, 'small')));
}

async function doBackup(materials) {
  try {
    if (materials && !cachesAvailable()) throw new Error('この環境では教材を含めたバックアップはできません');
    toast('バックアップを作成しています…', 60000);
    const blob = await createBackup(S.store, { materials, onProgress: (i, n) => toast(`バックアップを作成しています… ${i} / ${n}`, 60000) });
    const name = `講義バックアップ_${dateStamp()}${materials ? '' : '_書き込み'}.${materials ? 'zip' : 'json'}`;
    toast(`作成しました（${fmtBytes(blob.size)}）`);
    // 共有シートはタップの直後でないと開けないので、保存ボタンを押してもらう
    sheet(`バックアップを作成しました（${fmtBytes(blob.size)}）`, [
      { label: isAppleTouchDevice() ? '保存する（共有 →「ファイルに保存」）' : '保存する', fn: () => saveFile(blob, name) },
    ]);
  } catch (e) {
    console.error(e);
    toast(`バックアップに失敗しました：${e.message}`, 6000);
  }
}

async function doRestore() {
  const f = await pickFile('.zip,.json,application/zip,application/json');
  if (!f) return;
  try {
    const info = await inspectBackup(f);
    if (!confirm(`${info.summary}\n\nこのバックアップから復元します。バックアップに含まれる講義の書き込みは、バックアップの内容で置き換わります（含まれない講義はそのまま）。`)) return;
    toast('復元しています…', 60000);
    const r = await restoreBackup(S.store, info, { onProgress: (i, n) => toast(`復元しています… ${i} / ${n}`, 60000) });
    await loadState();
    closeModal();
    render();
    toast(`復元しました（書き込み ${r.ink} 講義${r.lectures ? `・教材 ${r.lectures} 件` : ''}）`, 5000);
  } catch (e) {
    console.error(e);
    toast(`復元できません：${e.message}`, 6000);
  }
}

// ---------------------------------------------------------------
// 小物
// ---------------------------------------------------------------
function sheet(title, acts, anchor) {
  closeModal();
  const panel = h('div', { class: 'lib-sheet' },
    h('div', { class: 'lib-sheet-title' }, title),
    acts.map((a) => h('button', {
      type: 'button', class: 'lib-sheet-item' + (a.danger ? ' danger' : ''), disabled: a.disabled,
      onclick: () => { closeModal(); a.fn(); },
    }, a.label)),
    h('button', { type: 'button', class: 'lib-sheet-item cancel', onclick: closeModal }, 'キャンセル'));
  const wrap = h('div', { class: 'lib-modal sheet', onclick: (e) => { if (e.target === wrap) closeModal(); } }, panel);
  document.body.appendChild(wrap);
  if (anchor && window.innerWidth > 700) {
    const r = anchor.getBoundingClientRect();
    panel.style.position = 'absolute';
    panel.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
    const top = r.bottom + 6;
    panel.style.top = Math.min(top, window.innerHeight - panel.offsetHeight - 12) + 'px';
  }
}

let toastEl = null;
let toastTimer = 0;
function toast(msg, ms = 2600) {
  if (!toastEl) {
    toastEl = h('div', { class: 'lw-toast', role: 'status' });
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function fmtDate(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今日 ${hm}`;
  return `${d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '/'}${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

main().catch((e) => {
  console.error(e);
  $('lib-list').appendChild(h('div', { class: 'lib-banner err' }, `起動できませんでした：${e.message}`));
});
