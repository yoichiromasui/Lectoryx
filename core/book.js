// =============================================================
// Book：講義 1 回分のページ列と書き込み状態（DOM に依存しない）
//
//   pages[i] = {
//     id,                         // 教材ページ: lecture.md 由来の ID / 白紙: 'blank-xxxx'
//     kind: 'source' | 'blank',
//     source,                     // 教材ページの {id, opts, title, html}
//     state: { strokes, texts, widgets, extra, bg },  // 保存対象（widgets は数値実験の値）
//     history,                    // Undo/Redo（保存しない）
//   }
//
// 白紙ページは「どのページの後ろに挿入したか（after）」を作成順に記録し、
// 読み込み時に教材ページ列へ差し込む。教材に後からページを追加しても位置が保たれる。
// =============================================================
import { History } from './ink/history.js';
import { validText } from './ink/text.js';
import { Emitter, uid } from './util.js';
import { SAVE_DELAY_MS, INK_FORMAT, INK_FORMAT_VERSION } from './config.js';

export class Book extends Emitter {
  constructor(lecture, saved, store) {
    super();
    this.lecture = lecture;
    this.store = store;
    this.saved = saved?.pages || {};
    this.meta = { added: [], lastPage: null, ...(saved?.meta || {}) };
    if (!Array.isArray(this.meta.added)) this.meta.added = [];
    this.dirty = new Set();
    this.deleted = new Set();
    this.metaDirty = false;
    this.timer = 0;
    this.saving = Promise.resolve();
    this.pages = this._build();
  }

  get length() { return this.pages.length; }
  indexOf(id) { return this.pages.findIndex((p) => p.id === id); }

  _makePage(id, kind, source, bg = null) {
    const rec = this.saved[id];
    const strokes = Array.isArray(rec?.strokes) ? rec.strokes.filter(validStroke) : [];
    const texts = Array.isArray(rec?.texts) ? rec.texts.filter(validText) : [];
    const widgets = validWidgets(rec?.widgets);
    return {
      id,
      kind,
      source,
      state: { strokes, texts, widgets, extra: Number(rec?.extra) || 0, bg: rec?.bg ?? bg },
      history: new History(),
    };
  }

  _build() {
    const pages = this.lecture.pages.map((p) => this._makePage(p.id, 'source', p));
    for (const a of this.meta.added) {
      const page = this._makePage(a.id, 'blank', null, a.bg || 'none');
      const idx = pages.findIndex((p) => p.id === a.after);
      if (idx >= 0) pages.splice(idx + 1, 0, page);
      else pages.push(page);
    }
    return pages;
  }

  title(page) {
    if (page.kind === 'blank') return '白紙';
    return page.source.title || '(無題)';
  }

  /** index の直後に白紙ページを追加し、その index を返す */
  addBlank(index, bg = 'none') {
    const after = this.pages[index];
    const id = 'blank-' + uid();
    this.meta.added.push({ id, after: after ? after.id : null, bg });
    const page = this._makePage(id, 'blank', null, bg);
    this.pages.splice(index + 1, 0, page);
    this.metaDirty = true;
    this.markDirty(page);
    return index + 1;
  }

  /** 白紙ページを削除（教材ページは削除できない） */
  removeBlank(index) {
    const page = this.pages[index];
    if (!page || page.kind !== 'blank') return false;
    const entry = this.meta.added.find((a) => a.id === page.id);
    for (const a of this.meta.added) if (a.after === page.id) a.after = entry ? entry.after : null;
    this.meta.added = this.meta.added.filter((a) => a.id !== page.id);
    this.pages.splice(index, 1);
    this.dirty.delete(page);
    this.deleted.add(page.id);
    this.metaDirty = true;
    this._schedule();
    return true;
  }

  setLastPage(id) {
    if (this.meta.lastPage === id) return;
    this.meta.lastPage = id;
    this.meta.lastScroll = 0;
    this.metaDirty = true;
    this._schedule();
  }

  /** 閲覧位置（最後のページ内のスクロール位置、論理px） */
  setScroll(y) {
    y = Math.max(0, Math.round(y || 0));
    if (this.meta.lastScroll === y) return;
    this.meta.lastScroll = y;
    this.metaDirty = true;
  }

  markDirty(page) {
    this.dirty.add(page);
    this._schedule();
  }

  _schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** 未保存の変更を書き込む */
  flush() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (!this.dirty.size && !this.deleted.size && !this.metaDirty) return this.saving;
    const now = Date.now();
    const pages = {};
    for (const p of this.dirty) {
      pages[p.id] = { strokes: p.state.strokes, texts: p.state.texts, widgets: p.state.widgets, extra: p.state.extra, bg: p.state.bg, updated: now };
      this.saved[p.id] = pages[p.id];
    }
    const deleted = [...this.deleted];
    for (const id of deleted) delete this.saved[id];
    const meta = this.metaDirty ? { ...this.meta, updated: now } : null;
    const retry = { pages: [...this.dirty], deleted, meta: !!meta };
    this.dirty.clear();
    this.deleted.clear();
    this.metaDirty = false;
    // IndexedDB は put() の時点でデータを複製するので、以降の変更の影響を受けない
    this.saving = this.saving
      .then(() => this.store.save(this.lecture.id, { pages, deleted, meta }))
      .then(() => this.emit('saved'))
      .catch((e) => {
        console.error(e);
        for (const p of retry.pages) this.dirty.add(p);
        for (const id of retry.deleted) this.deleted.add(id);
        if (retry.meta) this.metaDirty = true;
        this.emit('save-error', e);
      });
    return this.saving;
  }

  // ---- エクスポート / インポート ----
  exportData() {
    const pages = {};
    // 現在の教材にないページ（見出し変更などで ID が変わったもの）の書き込みも含める
    for (const [id, rec] of Object.entries(this.saved)) pages[id] = pickRecord(rec);
    for (const p of this.pages) {
      if (p.state.strokes.length || p.state.texts.length || Object.keys(p.state.widgets).length || p.state.extra || p.state.bg || this.saved[p.id]) {
        pages[p.id] = pickRecord(p.state);
      }
    }
    return {
      format: INK_FORMAT,
      version: INK_FORMAT_VERSION,
      lecture: this.lecture.id,
      title: this.lecture.meta.title || '',
      exportedAt: new Date().toISOString(),
      meta: { added: this.meta.added },
      pages,
    };
  }

  /** 書き込みデータを置き換える（呼び出し後にページを再読み込みする） */
  async importData(data) {
    if (!data || data.format !== INK_FORMAT) throw new Error('書き込みデータの形式が違います');
    clearTimeout(this.timer);
    await this.saving;
    await importInkData(this.store, this.lecture.id, data, { lastPage: this.meta.lastPage });
  }
}

/**
 * 講義 1 件分の書き込みを置き換える（講義ごとの書き出し・全体バックアップの復元で共通）
 * data = { version?, pages:{ID: PageRecord}, meta:{added, lastPage?} }
 */
export async function importInkData(store, lectureId, data, { lastPage } = {}) {
  if (data.version > INK_FORMAT_VERSION) throw new Error('新しい形式のデータです。アプリを更新してください');
  const pages = {};
  for (const [id, rec] of Object.entries(data.pages || {})) {
    if (!rec || typeof rec !== 'object') continue;
    pages[id] = {
      ...pickRecord(rec),
      strokes: (rec.strokes || []).filter(validStroke),
      texts: Array.isArray(rec.texts) ? rec.texts.filter(validText) : [],
      updated: Date.now(),
    };
  }
  const added = Array.isArray(data.meta?.added) ? data.meta.added.filter((a) => a && typeof a.id === 'string') : [];
  await store.clearLecture(lectureId);
  await store.save(lectureId, { pages, meta: { added, lastPage: lastPage ?? data.meta?.lastPage ?? null, updated: Date.now() } });
}

function pickRecord(r) {
  return { strokes: r.strokes || [], texts: r.texts || [], widgets: validWidgets(r.widgets), extra: Number(r.extra) || 0, bg: r.bg ?? null };
}

/** 数値実験の値 { "番号:名前": [値…] } */
function validWidgets(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return {};
  const out = {};
  for (const [k, v] of Object.entries(w)) if (Array.isArray(v)) out[k] = v;
  return out;
}

function validStroke(s) {
  return s && typeof s.id === 'string' && (s.t === 'pen' || s.t === 'hl') &&
    typeof s.c === 'string' && typeof s.w === 'number' &&
    Array.isArray(s.p) && s.p.length >= 3 && s.p.length % 3 === 0;
}
