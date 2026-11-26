// =============================================================
// PWA：Service Worker の登録と、アプリ本体の更新（sw.js とのやり取り）
//
// ・アプリの新しい版はバックグラウンドでダウンロードされるが、ユーザーがライブラリの
//   「アプリを更新」を押すまで切り替わらない（授業中に勝手に変わらない）。
// ・Service Worker は HTTPS か localhost でだけ動く（LAN の http://192.168… では無効）。
// =============================================================
const APP_ROOT = new URL('../', import.meta.url);

export const swSupported = () => 'serviceWorker' in navigator && window.isSecureContext;

let registering = null;

/** Service Worker を登録（何度呼んでもよい） */
export function registerSW() {
  if (!swSupported()) return Promise.resolve(null);
  if (!registering) {
    registering = navigator.serviceWorker
      .register(new URL('sw.js', APP_ROOT), { scope: APP_ROOT.href, updateViaCache: 'none' })
      .catch((e) => { console.warn('Service Worker を登録できません', e); return null; });
  }
  return registering;
}

/** オフライン配信が使える状態（このページを Service Worker が制御している）か */
export const swReady = () => !!(swSupported() && navigator.serviceWorker.controller);

/** 制御中（または指定）の Service Worker にメッセージを送って返事を待つ */
export function swMessage(msg, target = navigator.serviceWorker?.controller, timeout = 4000) {
  return new Promise((resolve) => {
    if (!target) { resolve(null); return; }
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), timeout);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
    target.postMessage(msg, [ch.port2]);
  });
}

/** Service Worker が制御を始めるまで待つ（初回インストール直後など） */
export function waitForController(timeout = 15000) {
  if (!swSupported()) return Promise.resolve(false);
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(!!navigator.serviceWorker.controller), timeout);
    navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); resolve(true); }, { once: true });
  });
}

/**
 * アプリの版の状態
 * @returns {{ supported, ready, current, latest, dev, updateAvailable, installing }}
 */
export async function appStatus() {
  if (!swSupported()) return { supported: false, ready: false };
  const reg = await navigator.serviceWorker.getRegistration(APP_ROOT.href);
  const ctl = navigator.serviceWorker.controller;
  const st = ctl ? await swMessage({ type: 'status' }, ctl) : null;
  const waiting = reg?.waiting || null;
  return {
    supported: true,
    ready: !!ctl,
    current: st?.current || null,
    latest: st?.latest || null,
    dev: !!st?.dev,
    installing: !!reg?.installing,
    updateAvailable: !!waiting || !!(st && st.current && st.latest && st.current !== st.latest),
  };
}

/** サーバーに新しい版があるか確認（あればバックグラウンドでダウンロードされる） */
export async function checkAppUpdate() {
  if (!swSupported()) return appStatus();
  const reg = await navigator.serviceWorker.getRegistration(APP_ROOT.href);
  if (reg) {
    try { await reg.update(); } catch { /* オフライン */ }
    const inst = reg.installing;
    if (inst) {
      await new Promise((resolve) => {
        const done = () => { if (inst.state === 'installed' || inst.state === 'activated' || inst.state === 'redundant') resolve(); };
        inst.addEventListener('statechange', done);
        setTimeout(resolve, 60000);
      });
    }
  }
  return appStatus();
}

/** ダウンロード済みの新しい版に切り替えて再読み込み */
export async function applyAppUpdate() {
  const reg = await navigator.serviceWorker.getRegistration(APP_ROOT.href);
  if (reg?.waiting) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 8000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); resolve(); }, { once: true });
      reg.waiting.postMessage({ type: 'skip-waiting' });
    });
  }
  await swMessage({ type: 'use-latest' });
  location.reload();
}
