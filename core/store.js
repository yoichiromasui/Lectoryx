// =============================================================
// 永続化（IndexedDB "lecture-web"）
//
//   "pages"    key = `${lectureId}\u0001${pageId}` → PageRecord（手書き・テキスト・数値実験の値）
//   "lectures" key = lectureId                      → LectureMeta（白紙ページ・閲覧位置）
//   "library"  key = lectureId                      → LibraryRecord（ダウンロードした教材の版）
//   "kv"       key = 文字列                         → 設定・最後に取得した教材一覧・最近使った教材
//
//   PageRecord  = { strokes, texts, widgets, extra, bg, updated }
//   LectureMeta = { added: [{id, after, bg}], lastPage, lastScroll, inked（書き込みのあるページ数）, updated }
//   LibraryRecord は core/library/download.js を参照。
//
// 教材本体（ファイル）は Cache Storage（core/library/download.js, sw.js）。書き込みとは別に管理し、
// 教材を削除・更新しても書き込みは消えない。
// IndexedDB が使えない環境（古いプライベートブラウズ等）ではメモリのみで動作する。
// =============================================================
import { DB_NAME, DB_VERSION } from './config.js';

const SEP = '\u0001';
const STORES = ['pages', 'lectures', 'library', 'kv'];

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
  });
}

const lectureRange = (id) => IDBKeyRange.bound(id + SEP, id + SEP + '￿');

let opening = null;

/** 何度呼んでも同じ接続を返す */
export function openStore() {
  if (!opening) opening = open();
  return opening;
}

async function open() {
  if (!('indexedDB' in window)) return new MemoryStore();
  try {
    const o = indexedDB.open(DB_NAME, DB_VERSION);
    o.onupgradeneeded = () => {
      // 既存のストア（書き込み）はそのまま。足りないストアだけ作る
      const db = o.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    o.onblocked = () => console.warn('古い版のアプリが開いているため、データベースの更新を待っています');
    const db = await req(o);
    db.onversionchange = () => db.close();
    return new IdbStore(db);
  } catch (e) {
    console.warn('IndexedDB を開けません。保存は無効です。', e);
    return new MemoryStore();
  }
}

class IdbStore {
  constructor(db) {
    this.db = db;
    this.persistent = true;
  }

  // ---- 書き込み（講義ごと） ----
  async loadLecture(lectureId) {
    const tx = this.db.transaction(['pages', 'lectures'], 'readonly');
    const ps = tx.objectStore('pages');
    const [keys, values, meta] = await Promise.all([
      req(ps.getAllKeys(lectureRange(lectureId))),
      req(ps.getAll(lectureRange(lectureId))),
      req(tx.objectStore('lectures').get(lectureId)),
    ]);
    const pages = {};
    keys.forEach((k, i) => { pages[k.slice(lectureId.length + 1)] = values[i]; });
    return { meta: meta || null, pages };
  }

  /** 複数ページ・メタをまとめて保存（1 トランザクション） */
  async save(lectureId, { pages = {}, deleted = [], meta = null }) {
    const tx = this.db.transaction(['pages', 'lectures'], 'readwrite');
    const ps = tx.objectStore('pages');
    for (const [pageId, rec] of Object.entries(pages)) ps.put(rec, lectureId + SEP + pageId);
    for (const pageId of deleted) ps.delete(lectureId + SEP + pageId);
    if (meta) tx.objectStore('lectures').put(meta, lectureId);
    await done(tx);
  }

  async clearLecture(lectureId) {
    const tx = this.db.transaction(['pages', 'lectures'], 'readwrite');
    tx.objectStore('pages').delete(lectureRange(lectureId));
    tx.objectStore('lectures').delete(lectureId);
    await done(tx);
  }

  /** 書き込み（手書き・テキスト）のあるページ ID の一覧 */
  async inkedPages(lectureId) {
    const { pages } = await this.loadLecture(lectureId);
    return Object.keys(pages).filter((id) => hasInk(pages[id]));
  }

  /** 全講義の書き込み（バックアップ用）：{ lectureId: { meta, pages } } */
  async exportAllInk() {
    const tx = this.db.transaction(['pages', 'lectures'], 'readonly');
    const ps = tx.objectStore('pages');
    const ls = tx.objectStore('lectures');
    const [keys, values, lkeys, lvalues] = await Promise.all([
      req(ps.getAllKeys()), req(ps.getAll()), req(ls.getAllKeys()), req(ls.getAll()),
    ]);
    const out = {};
    const get = (id) => (out[id] ||= { meta: null, pages: {} });
    keys.forEach((k, i) => {
      const j = k.indexOf(SEP);
      if (j > 0) get(k.slice(0, j)).pages[k.slice(j + 1)] = values[i];
    });
    lkeys.forEach((k, i) => { get(k).meta = lvalues[i]; });
    return out;
  }

  /** 書き込みのある講義の ID → ページ数 */
  async inkSummary() {
    // 通常は講義ごとのメタに記録したページ数だけを読む（全ページの書き込みを読むと重いため）
    const ls = this.db.transaction('lectures').objectStore('lectures');
    const [ids, metas] = await Promise.all([req(ls.getAllKeys()), req(ls.getAll())]);
    const out = {};
    const legacy = [];
    ids.forEach((id, i) => {
      const n = metas[i]?.inked;
      if (typeof n === 'number') { if (n) out[id] = n; } else legacy.push(id);
    });
    // 記録がない古いデータだけ数える
    for (const id of legacy) {
      const n = (await this.inkedPages(id)).length;
      if (n) out[id] = n;
    }
    return out;
  }

  // ---- 教材ライブラリ ----
  async getLibrary() {
    return req(this.db.transaction('library').objectStore('library').getAll());
  }
  async getRecord(id) {
    return (await req(this.db.transaction('library').objectStore('library').get(id))) || null;
  }
  async putRecord(rec) {
    const tx = this.db.transaction('library', 'readwrite');
    tx.objectStore('library').put(rec, rec.id);
    await done(tx);
  }
  async deleteRecord(id) {
    const tx = this.db.transaction('library', 'readwrite');
    tx.objectStore('library').delete(id);
    await done(tx);
  }

  // ---- 設定など ----
  async kvGet(key) {
    return req(this.db.transaction('kv').objectStore('kv').get(key));
  }
  async kvSet(key, value) {
    const tx = this.db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    await done(tx);
  }
}

class MemoryStore {
  constructor() {
    this.persistent = false;
    this.data = new Map();
    this.lib = new Map();
    this.kv = new Map();
  }
  async loadLecture(id) { return this.data.get(id) || { meta: null, pages: {} }; }
  async save(id, { pages = {}, deleted = [], meta = null }) {
    const d = this.data.get(id) || { meta: null, pages: {} };
    Object.assign(d.pages, pages);
    for (const p of deleted) delete d.pages[p];
    if (meta) d.meta = meta;
    this.data.set(id, d);
  }
  async clearLecture(id) { this.data.delete(id); }
  async inkedPages(id) {
    const { pages } = await this.loadLecture(id);
    return Object.keys(pages).filter((p) => hasInk(pages[p]));
  }
  async exportAllInk() { return Object.fromEntries(this.data); }
  async inkSummary() {
    const out = {};
    for (const [id, d] of this.data) {
      const n = Object.values(d.pages).filter(hasInk).length;
      if (n) out[id] = n;
    }
    return out;
  }
  async getLibrary() { return [...this.lib.values()]; }
  async getRecord(id) { return this.lib.get(id) || null; }
  async putRecord(rec) { this.lib.set(rec.id, rec); }
  async deleteRecord(id) { this.lib.delete(id); }
  async kvGet(k) { return this.kv.get(k); }
  async kvSet(k, v) { this.kv.set(k, v); }
}

export function hasInk(rec) {
  return !!rec && ((rec.strokes && rec.strokes.length) || (rec.texts && rec.texts.length));
}

/** ブラウザにストレージの永続化を依頼（許可されると容量不足時にも自動削除されにくくなる） */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist?.();
    }
    return !!(await navigator.storage?.persisted?.());
  } catch {
    return false;
  }
}

/** 使用量・上限（バイト）。取得できなければ null */
export async function storageEstimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e) return null;
    const persisted = await navigator.storage.persisted?.().catch(() => false);
    return { usage: e.usage || 0, quota: e.quota || 0, persisted: !!persisted };
  } catch {
    return null;
  }
}

/** 容量不足のエラーか */
export function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota|容量/i.test(e.message || ''));
}
