/* =============================================================
   Service Worker：iPad 単独（オフライン）で動かすための配信層

   1. アプリ本体（index.html, lecture.html, core/, vendor/, assets/）
      インストール時に Cache Storage「lw-app-<版>」へ保存し、以後はそこから返す。
      どの版を使うかは「lw-meta」に記録した版（ポインタ）で決まり、
      新しい版をダウンロードしても、ユーザーが「アプリを更新」を押すまで切り替えない
      （授業中に勝手に変わらない）。開発時（tools/serve.py）はネットワーク優先。

   2. ダウンロードした教材
      ライブラリが教材 1 版ごとに「lw-lec-<版>」へ保存する。講義画面は
        <アプリ>/offline/<版>/<教材ルートからのパス>
      という URL で教材を読み込み、ここで Cache Storage から返す（動画の Range 要求にも対応）。
      版ごとに別の URL なので、旧版と新版を並べて残せる。

   BUILD は tools/build.py（公開時）・tools/serve.py（開発時）が埋め込む。
   ============================================================= */
const BUILD = /*BUILD*/{"version":"dev","files":[],"dev":true}/*END*/;

const SCOPE = new URL(self.registration.scope);
const APP_PREFIX = 'lw-app-';
const LEC_PREFIX = 'lw-lec-';
const META = 'lw-meta';
const POINTER_KEY = new URL('__lw/app-version', SCOPE).href;
const FILES = new Map(BUILD.files.map(([path, hash]) => [path, hash]));

let pointer = null;        // 使用中のアプリの版
let testOffline = false;   // テスト用：ネットワークを使わない（tests/offline.html から）

async function getPointer() {
  if (pointer) return pointer;
  const r = await (await caches.open(META)).match(POINTER_KEY);
  pointer = r ? await r.text() : null;
  return pointer;
}

async function setPointer(v) {
  pointer = v;
  await (await caches.open(META)).put(POINTER_KEY, new Response(v));
}

const appKey = (path) => new URL(path, SCOPE).href;

// ---------------------------------------------------------------
// インストール：アプリ本体を保存（前の版と同じ内容のファイルは再利用）
// ---------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const name = APP_PREFIX + BUILD.version;
    const cache = await caches.open(name);
    const old = [];
    for (const n of await caches.keys()) if (n.startsWith(APP_PREFIX) && n !== name) old.push(await caches.open(n));
    const queue = [...FILES];
    const worker = async () => {
      while (queue.length) {
        const [path, hash] = queue.shift();
        const key = appKey(path);
        if (await cache.match(key)) continue;
        let res = null;
        for (const c of old) {
          const hit = await c.match(key);
          if (hit && hit.headers.get('X-LW-Hash') === hash) { res = hit; break; }
        }
        if (!res) {
          const net = await fetch(key, { cache: 'reload' });
          if (!net.ok) throw new Error(`${path}: HTTP ${net.status}`);
          const headers = new Headers(net.headers);
          headers.set('X-LW-Hash', hash);
          res = new Response(await net.blob(), { status: 200, headers });
        }
        await cache.put(key, res);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    // 初回、または開発時はこの版をすぐ使う
    if (BUILD.dev || !(await getPointer())) await setPointer(BUILD.version);
    if (BUILD.dev) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    await cleanupAppCaches();
  })());
});

/** 使用中の版と最新の版以外のアプリのキャッシュを消す */
async function cleanupAppCaches() {
  const keep = new Set([APP_PREFIX + BUILD.version, APP_PREFIX + (await getPointer())]);
  for (const n of await caches.keys()) {
    if (n.startsWith(APP_PREFIX) && !keep.has(n)) await caches.delete(n);
  }
}

// ---------------------------------------------------------------
// ページとのやり取り（core/pwa.js）
// ---------------------------------------------------------------
self.addEventListener('message', (event) => {
  const d = event.data || {};
  const reply = (x) => event.ports[0]?.postMessage(x);
  if (d.type === 'status') {
    event.waitUntil(getPointer().then((p) => reply({ current: p, latest: BUILD.version, dev: BUILD.dev })));
  } else if (d.type === 'skip-waiting') {
    self.skipWaiting();
  } else if (d.type === 'use-latest') {
    event.waitUntil(setPointer(BUILD.version).then(cleanupAppCaches).then(() => reply({ ok: true, current: BUILD.version })));
  } else if (d.type === 'test-offline') {
    testOffline = !!d.on;
    reply({ ok: true, testOffline });
  }
});

// ---------------------------------------------------------------
// 配信
// ---------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' && req.method !== 'HEAD') return;
  const url = new URL(req.url);
  if (url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname)) {
    let path;
    try { path = decodeURIComponent(url.pathname.slice(SCOPE.pathname.length)); } catch { path = ''; }
    if (path.startsWith('offline/')) { event.respondWith(serveLecture(req, url, path)); return; }
    if (path === '' || FILES.has(path)) { event.respondWith(serveApp(req, path || 'index.html')); return; }
  }
  if (testOffline) event.respondWith(Response.error());
});

async function serveApp(req, path) {
  if (BUILD.dev && !testOffline) {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) return res;
    } catch { /* オフライン → キャッシュから */ }
  }
  const key = appKey(path);
  const v = await getPointer();
  let hit = null;
  if (v && await caches.has(APP_PREFIX + v)) hit = await (await caches.open(APP_PREFIX + v)).match(key);
  if (!hit) {
    for (const n of await caches.keys()) {
      if (!n.startsWith(APP_PREFIX)) continue;
      hit = await (await caches.open(n)).match(key);
      if (hit) break;
    }
  }
  if (hit) return req.method === 'HEAD' ? new Response(null, { headers: hit.headers }) : hit;
  if (testOffline) return Response.error();
  return fetch(req);
}

async function serveLecture(req, url, path) {
  const m = /^offline\/([0-9a-f]+)\//.exec(path);
  const name = m && LEC_PREFIX + m[1];
  const res = name && await caches.has(name) ? await (await caches.open(name)).match(url.origin + url.pathname) : null;
  if (!res) return new Response('この教材ファイルは端末に保存されていません', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (req.method === 'HEAD') return new Response(null, { status: 200, headers: res.headers });
  const range = req.headers.get('range');
  return range ? rangeResponse(res, range) : res;
}

/** 動画・音声の部分取得（Safari は <video> で必ず Range 要求を使う） */
async function rangeResponse(res, header) {
  const blob = await res.blob();
  const size = blob.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return new Response(blob, { status: 200, headers: res.headers });
  let start, end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const headers = new Headers(res.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(blob.slice(start, end + 1), { status: 206, headers });
}
