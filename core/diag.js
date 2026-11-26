// =============================================================
// 動作の記録（不具合の報告用）
//   ・画面が固まった（JavaScript が 0.25 秒以上応答しなかった）時刻と長さ
//   ・手のひら対策で指のタッチを無視したこと
//   ・ページの表示・PDF の描画・保存・グラフの描画に時間がかかったこと、エラー
// を最大 300 件まで記録する（端末内のみ。外部には送らない）。講義画面の ⋯ →「動作の記録」で表示・コピーできる。
// 監視は 100ms ごとのタイマーの遅れを見るだけなので軽い。
// =============================================================
const KEY = 'lw.diag.v1';
const MAX = 300;
let log = [];
const lastByType = new Map();
let saveTimer = 0;

try { log = JSON.parse(localStorage.getItem(KEY) || '[]').slice(-MAX); } catch { log = []; }

/** 記録する。throttle（ms）を指定すると、同じ種類はその間隔より短いと記録しない */
export function diag(type, detail = '', throttle = 0) {
  const now = Date.now();
  if (throttle && now - (lastByType.get(type) || 0) < throttle) return;
  lastByType.set(type, now);
  log.push({ t: now, type, detail: String(detail).slice(0, 300) });
  if (log.length > MAX) log.splice(0, log.length - MAX);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 1000);
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(log)); } catch { /* 容量不足等 */ }
}

/** 処理時間を測って、limit ms を超えたら記録する */
export function timed(type, label, limit, fn) {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - t0;
    if (ms > limit) diag(type, `${label} ${Math.round(ms)}ms`);
  }
}

const LABEL = {
  stall: '固まった', palm: 'タッチ無視', page: 'ページ', pdf: 'PDF描画', save: '保存', widget: 'グラフ描画',
  ink: '書き込み描画', error: 'エラー', state: '状態', start: '起動',
};

/** 表示・コピー用の文字列 */
export function diagText(context = '') {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const fmt = (t) => {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  const head = [
    `Lectoryx 動作の記録（${new Date().toLocaleString('ja-JP')}）`,
    `端末: ${navigator.userAgent}`,
    `画面: ${screen.width}×${screen.height} dpr ${window.devicePixelRatio} / 表示 ${innerWidth}×${innerHeight}`,
    context,
    '',
  ].filter((x) => x !== null);
  const lines = log.slice().reverse().map((e) => `${fmt(e.t)}  ${LABEL[e.type] || e.type}  ${e.detail}`);
  return head.concat(lines.length ? lines : ['（記録なし）']).join('\n');
}

export function clearDiag() {
  log = [];
  persist();
}

let started = false;

/** 応答の遅れ・エラーの監視を始める（講義画面の起動時に 1 回） */
export function startDiag(label = '') {
  if (started) return;
  started = true;
  diag('start', label);
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const gap = now - last - 100;
    last = now;
    if (gap > 250 && document.visibilityState === 'visible') diag('stall', `${Math.round(gap)}ms 応答なし`);
  }, 100);
  document.addEventListener('visibilitychange', () => {
    last = performance.now();
    diag('state', document.visibilityState === 'visible' ? '前面に戻った' : '背面へ');
    if (document.visibilityState === 'hidden') persist();
  });
  window.addEventListener('error', (e) => diag('error', `${e.message} (${(e.filename || '').replace(/^.*\//, '')}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => diag('error', e.reason?.message || String(e.reason)));
}
