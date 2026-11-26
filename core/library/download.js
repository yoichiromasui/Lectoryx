// =============================================================
// 教材の取得・保存・版の管理
//
//   LibraryRecord（IndexedDB "library"、キー = 講義 ID）= {
//     id, path,                       講義 ID（書き込みのキー）と教材ルートからのパス
//     current,                        使用中の版
//     versions: { [版]: {
//       version, entry,               catalog.json のエントリ（タイトル・ファイル一覧など）
//       downloadedAt, bytes,
//       sigs: { pages:{ページID:署名}, pdf:{接頭辞:署名} },   ページ内容の署名（更新でずれるかの判定）
//       changed: [ページID],          前の版から内容が変わった、書き込みのあるページ
//       prev, kept,                   前の版 / 書き込み保護のために残している旧版か
//     } },
//     source,                         取得元の教材ルート
//   }
//   ファイルは Cache Storage「lw-lec-<版>」に offline/<版>/<パス> の URL で保存（sw.js が配信）。
//
// 安全のための方針
//   ・新しい版は別の場所にすべて取得し、サイズ・SHA-256 を確認してから切り替える
//     （途中で失敗しても使用中の版はそのまま）。
//   ・更新で「書き込みのあるページ」の内容が変わった場合は旧版を残す（旧版で開ける）。
//   ・書き込みは版と無関係に講義 ID + ページ ID で保存されているので、更新・削除で消えない。
// =============================================================
import { Emitter } from '../util.js';
import { parseLecture } from '../content/markdown.js';
import { getSource, sourceKey, offlineRoot, encodePath } from '../content/source.js';
import { isQuotaError, requestPersistence } from '../store.js';

export const LEC_CACHE = (v) => 'lw-lec-' + v;
const CATALOG_KEY = 'catalog';

const MIME = {
  md: 'text/markdown; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', mp4: 'video/mp4',
  m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  wav: 'audio/wav', csv: 'text/csv; charset=utf-8', txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8',
};
const MIME_KNOWN = (path) => MIME[(/\.([^./]+)$/.exec(path)?.[1] || '').toLowerCase()] || null;
const mimeOf = (path) => MIME_KNOWN(path) || 'application/octet-stream';

export const cachesAvailable = () => typeof caches !== 'undefined' && window.isSecureContext;

// ---------------------------------------------------------------
// 教材一覧（catalog.json）
// ---------------------------------------------------------------
async function fetchWithTimeout(url, ms, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('接続がタイムアウトしました');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---- 配信元からの取得（URL ／ GitHub の非公開リポジトリ） ----
function githubError(status, what) {
  if (status === 401) return new Error('GitHub のアクセストークンが無効か、有効期限が切れています（⋯ →「教材の配信元」でトークンを入れ直してください）');
  if (status === 403) return new Error('GitHub へのアクセスが拒否されました（トークンの権限「Contents：読み取り」と対象リポジトリを確認してください。短時間に多数のアクセスをした場合は少し待ってください）');
  if (status === 404) return new Error(`${what} が見つかりません（リポジトリ名、dist ブランチがあるか（GitHub Actions が成功しているか）、トークンにこのリポジトリの権限があるかを確認してください）`);
  return new Error(`${what} を取得できません（GitHub HTTP ${status}）`);
}

async function githubFetch(src, path, ms, opts = {}) {
  const url = `${src.api}/repos/${src.repo}/${path}`;
  const res = await fetchWithTimeout(url, ms, {
    ...opts, cache: 'no-store', credentials: 'omit',
    headers: { Authorization: `Bearer ${src.token}`, Accept: opts.accept || 'application/vnd.github.raw+json' },
  });
  return res;
}

/** GitHub：ブランチの最新コミット（教材一覧とファイルを同じ時点のものにそろえるため） */
async function githubHead(src) {
  const res = await githubFetch(src, `git/ref/heads/${encodeURIComponent(src.branch)}`, 15000, { accept: 'application/vnd.github+json' });
  if (!res.ok) throw githubError(res.status, `リポジトリ ${src.repo} のブランチ ${src.branch}`);
  const sha = (await res.json())?.object?.sha;
  if (!sha) throw new Error('ブランチの情報を読めません');
  return sha;
}

/** 配信元のファイル（教材ルートからの相対パス）を取得 */
async function remoteFetch(src, path, { ref, timeout = 30000 } = {}) {
  if (src.type === 'github') {
    const res = await githubFetch(src, `contents/${encodePath(path)}?ref=${encodeURIComponent(ref || src.branch)}`, timeout);
    if (!res.ok) throw githubError(res.status, path);
    return res;
  }
  const res = await fetchWithTimeout(new URL(encodePath(path), src.url), timeout, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`${path} を取得できません（HTTP ${res.status}）`);
  return res;
}

/** 配信元から教材一覧を取得して保存（オフライン時の表示用） */
export async function fetchCatalog(store) {
  const src = getSource();
  const ref = src.type === 'github' ? await githubHead(src) : null;
  let res;
  try {
    res = await remoteFetch(src, 'catalog.json', { ref, timeout: 15000 });
  } catch (e) {
    if (src.type === 'url' && /HTTP 404/.test(e.message)) {
      throw Object.assign(new Error('教材一覧（catalog.json）が見つかりません。教材の配信元を設定してください'), { code: 'no-catalog' });
    }
    throw e;
  }
  const data = await res.json();
  if (data?.format !== 'lecture-web-catalog' || !Array.isArray(data.lectures)) throw new Error('教材一覧の形式が違います');
  const saved = { root: sourceKey(src), ref, fetchedAt: Date.now(), data };
  await store.kvSet(CATALOG_KEY, saved);
  return saved;
}

/** 最後に取得した教材一覧（配信元を変えた後は null） */
export async function cachedCatalog(store) {
  const c = await store.kvGet(CATALOG_KEY);
  return c && c.root === sourceKey() ? c : null;
}

/** 配信元に接続できるか確認（設定画面用）。教材の件数を返す */
export async function testSource(src) {
  const ref = src.type === 'github' ? await githubHead(src) : null;
  const res = await remoteFetch(src, 'catalog.json', { ref, timeout: 15000 });
  const data = await res.json();
  if (data?.format !== 'lecture-web-catalog') throw new Error('教材一覧の形式が違います');
  return data.lectures.length;
}

// ---------------------------------------------------------------
// ページ内容の署名（更新で書き込みがずれるかの判定用）
// ---------------------------------------------------------------
function hash53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * 各ページの署名：ページの本文・属性・参照するファイル（画像など）・
 * ウィジェットのあるページは widgets.js（と import 先）・PDF のページは PDF ファイルの内容。
 */
export function pageSignatures(mdText, entry) {
  const parsed = parseLecture(mdText);
  const dir = entry.path + '/';
  const files = entry.files.map((f) => ({ ...f, local: f.path.startsWith(dir) ? f.path.slice(dir.length) : f.path }));
  const jsHash = files.filter((f) => /\.m?js$/.test(f.path)).map((f) => f.hash).join(',');
  const sigs = { pages: {}, pdf: {} };
  for (const p of parsed.pages) {
    if (p.pdf) {
      const file = String(p.pdf._[0] || p.pdf.src || '');
      const prefix = String(p.pdf.id ?? p.opts.id ?? file.replace(/^.*\//, '').replace(/\.pdf$/i, ''));
      const f = files.find((x) => x.local === file.replace(/^\.\//, ''));
      sigs.pdf[prefix] = hash53(`${file}|${p.pdf.pages ?? ''}|${f?.hash ?? ''}|${sigs.pdf[prefix] ?? ''}`);
      continue;
    }
    let s = JSON.stringify(p.opts) + '\n' + p.src;
    if (/^@widget\b/m.test(p.src)) s += '\nJS:' + jsHash;
    for (const f of files) if (f.local !== 'lecture.md' && p.src.includes(f.local)) s += `\n${f.local}:${f.hash}`;
    sigs.pages[p.id] = hash53(s);
  }
  return sigs;
}

function sigOf(sigs, pageId) {
  if (!sigs) return undefined;
  if (pageId in sigs.pages) return sigs.pages[pageId];
  for (const prefix of Object.keys(sigs.pdf)) {
    if (pageId.startsWith(prefix + '-') && /^\d+(~\d+)?$/.test(pageId.slice(prefix.length + 1))) return sigs.pdf[prefix];
  }
  return undefined;
}

/** 書き込みのあるページのうち、内容が変わった（または無くなった）ページ */
export function changedInkedPages(oldSigs, newSigs, inkedIds) {
  if (!oldSigs) return [];
  return inkedIds.filter((id) => {
    if (id.startsWith('blank-')) return false;          // 追加した白紙ページは教材と無関係
    const a = sigOf(oldSigs, id);
    if (a === undefined) return false;                  // 旧版にもなかったページ（教材の外の記録）
    return sigOf(newSigs, id) !== a;
  });
}

// ---------------------------------------------------------------
// 状態
// ---------------------------------------------------------------
/** 'none' | 'queued' | 'downloading' | 'failed' | 'ready' | 'update' */
export function statusOf(entry, rec, job) {
  if (job && (job.state === 'queued' || job.state === 'downloading')) return job.state;
  if (job && job.state === 'failed') return 'failed';
  if (!rec || rec._missing) return 'none';           // _missing：記録はあるがファイルが消えている
  if (entry && entry.version !== rec.current && !rec.versions[entry.version]) return 'update';
  return 'ready';
}

// ---------------------------------------------------------------
// ダウンロード
// ---------------------------------------------------------------
async function sha256Hex(buf) {
  if (!crypto?.subtle) return null;
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 他の版に同じ内容のファイルがあれば再利用（更新時に動画などを取り直さない） */
async function findSame(rec, path, hash) {
  if (!rec) return null;
  for (const v of Object.keys(rec.versions)) {
    if (!(await caches.has(LEC_CACHE(v)))) continue;
    const hit = await (await caches.open(LEC_CACHE(v))).match(offlineRoot(v) + encodePath(path));
    if (hit && hit.headers.get('X-LW-Hash') === hash) return hit;
  }
  return null;
}

async function checkSpace(bytes) {
  try {
    const e = await navigator.storage?.estimate?.();
    if (e && e.quota && e.quota - e.usage < bytes * 1.1 + 5e6) {
      const err = new Error(`保存容量が足りません（必要 ${fmtBytes(bytes)}、空き ${fmtBytes(e.quota - e.usage)}）。不要な教材を削除してください`);
      err.name = 'QuotaExceededError';
      throw err;
    }
  } catch (e) {
    if (isQuotaError(e)) throw e;
  }
}

export function fmtBytes(n) {
  if (!(n >= 0)) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * 1 つの教材（catalog のエントリ）をダウンロードして使える状態にする。
 * @returns {{ rec, changed:string[], keptOld:boolean, updated:boolean }}
 */
export async function downloadLecture(store, entry, { onProgress = () => {} } = {}) {
  if (!cachesAvailable()) throw new Error('この環境（http 接続など）では教材を端末に保存できません。https のアドレスで開いてください');
  const version = entry.version;
  const src = getSource();
  // GitHub では教材一覧を取得した時点のコミットからファイルを取る（途中で push されても混ざらない）
  const ref = src.type === 'github' ? (await cachedCatalog(store))?.ref : null;
  const vroot = offlineRoot(version);
  const rec = await store.getRecord(entry.id);
  const already = rec?.versions?.[version];
  if (already && rec.current === version && await verifyVersion(version, entry)) return { rec, changed: [], keptOld: false, updated: false };

  const need = entry.files.reduce((s, f) => s + f.size, 0);
  await checkSpace(need);
  requestPersistence();

  const cache = await caches.open(LEC_CACHE(version));
  const total = entry.files.length;
  let done = 0;
  let loaded = 0;
  const report = () => onProgress({ done, total, loaded, size: need });
  report();
  const queue = [...entry.files];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const key = vroot + encodePath(f.path);
      const have = await cache.match(key);
      if (!(have && have.headers.get('X-LW-Hash') === f.hash)) {
        let res = await findSame(rec, f.path, f.hash);
        if (!res) {
          const net = await remoteFetch(src, f.path, { ref, timeout: 30000 + f.size / 100 });
          const buf = await net.arrayBuffer();
          if (buf.byteLength !== f.size) throw new Error(`${f.path} のサイズが一覧と違います（配信の更新中かもしれません。少し待って再試行してください）`);
          const hex = await sha256Hex(buf);
          if (hex && f.hash && hex !== f.hash) throw new Error(`${f.path} の内容が一覧と違います（配信の更新中かもしれません。少し待って再試行してください）`);
          const headers = new Headers({
            'Content-Type': MIME_KNOWN(f.path) || net.headers.get('content-type') || mimeOf(f.path),
            'Content-Length': String(f.size),
            'X-LW-Hash': f.hash,
            'Accept-Ranges': 'bytes',
          });
          const lm = net.headers.get('last-modified');
          if (lm) headers.set('Last-Modified', lm);
          res = new Response(buf, { status: 200, headers });
        }
        try {
          await cache.put(key, res);
        } catch (e) {
          if (isQuotaError(e)) throw Object.assign(new Error('保存容量が足りません。不要な教材を削除してください'), { name: 'QuotaExceededError' });
          throw e;
        }
      }
      done++;
      loaded += f.size;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, total || 1) }, worker));

  // すべて揃ったことを確認してから「使える」にする
  if (!(await verifyVersion(version, entry))) throw new Error('一部のファイルを保存できませんでした。再試行してください');
  const mdRes = await cache.match(vroot + encodePath(entry.path) + '/lecture.md');
  const sigs = pageSignatures(await mdRes.text(), entry);

  const prev = rec?.current && rec.current !== version ? rec.current : null;
  let changed = [];
  if (prev) changed = changedInkedPages(rec.versions[prev]?.sigs, sigs, await store.inkedPages(entry.id));
  const next = rec ? { ...rec, versions: { ...rec.versions } } : { id: entry.id, path: entry.path, versions: {} };
  next.path = entry.path;
  next.source = sourceKey(src);
  next.current = version;
  next.versions[version] = { version, entry, downloadedAt: Date.now(), bytes: need, sigs, changed, prev };
  const keptOld = !!(prev && changed.length);
  if (prev) {
    if (keptOld) next.versions[prev] = { ...next.versions[prev], kept: true };
    else delete next.versions[prev];
  }
  await store.putRecord(next);
  if (prev && !keptOld && !next.versions[prev]) await caches.delete(LEC_CACHE(prev));
  return { rec: next, changed, keptOld, updated: !!prev };
}

/** 版のファイルがすべて端末にあるか */
export async function verifyVersion(version, entry) {
  if (!(await caches.has(LEC_CACHE(version)))) return false;
  const cache = await caches.open(LEC_CACHE(version));
  const vroot = offlineRoot(version);
  for (const f of entry.files) {
    const hit = await cache.match(vroot + encodePath(f.path));
    if (!hit || hit.headers.get('X-LW-Hash') !== f.hash) return false;
  }
  return true;
}

/** 教材を端末から削除（書き込みは ink=true のときだけ削除） */
export async function removeLecture(store, id, { ink = false } = {}) {
  const rec = await store.getRecord(id);
  if (rec) {
    for (const v of Object.keys(rec.versions)) await caches.delete(LEC_CACHE(v));
    await store.deleteRecord(id);
  }
  if (ink) await store.clearLecture(id);
}

/** 旧版を削除 */
export async function removeVersion(store, id, version) {
  const rec = await store.getRecord(id);
  if (!rec || !rec.versions[version] || rec.current === version) return;
  const next = { ...rec, versions: { ...rec.versions } };
  delete next.versions[version];
  await store.putRecord(next);
  await caches.delete(LEC_CACHE(version));
}

/** どの教材にも属さないキャッシュ（中断したダウンロードの残り等）を消す */
export async function cleanupCaches(store, busy = new Set()) {
  if (!cachesAvailable()) return;
  const used = new Set(busy);
  for (const r of await store.getLibrary()) for (const v of Object.keys(r.versions)) used.add(v);
  for (const n of await caches.keys()) {
    if (n.startsWith('lw-lec-') && !used.has(n.slice(7))) await caches.delete(n);
  }
}

// ---------------------------------------------------------------
// ダウンロードの順番待ち（1 教材ずつ。UI は 'change' で状態を受け取る）
// ---------------------------------------------------------------
export class Downloader extends Emitter {
  constructor(store) {
    super();
    this.store = store;
    this.jobs = new Map();      // id → { state, done, total, loaded, size, error, entry }
    this.queue = [];
    this.running = false;
  }
  get busyVersions() {
    return new Set([...this.jobs.values()].filter((j) => j.state !== 'failed').map((j) => j.entry.version));
  }
  enqueue(entries) {
    for (const e of entries) {
      const j = this.jobs.get(e.id);
      if (j && (j.state === 'queued' || j.state === 'downloading')) continue;
      this.jobs.set(e.id, { state: 'queued', done: 0, total: e.files.length, loaded: 0, size: e.size, error: null, entry: e });
      this.queue.push(e);
    }
    this.emit('change');
    this._run();
  }
  async _run() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const e = this.queue.shift();
      const job = this.jobs.get(e.id);
      job.state = 'downloading';
      this.emit('change', e.id);
      try {
        const r = await downloadLecture(this.store, e, {
          onProgress: (p) => { Object.assign(job, p); this.emit('progress', e.id, job); },
        });
        this.jobs.delete(e.id);
        this.emit('done', e.id, r);
      } catch (err) {
        console.error(err);
        job.state = 'failed';
        job.error = err;
        this.emit('failed', e.id, err);
        if (isQuotaError(err)) {                  // 容量不足なら残りも止める
          for (const q of this.queue) Object.assign(this.jobs.get(q.id), { state: 'failed', error: err });
          this.queue.length = 0;
        }
      }
      this.emit('change', e.id);
    }
    this.running = false;
  }
}
