// =============================================================
// バックアップと復元
//   ・すべてをバックアップ（.zip）：書き込み（全講義）＋ダウンロード済みの教材（全版）
//       backup.json                 { format:'lecture-web-backup', version:1, createdAt, source, library, ink }
//                                   （source は配信元。GitHub のアクセストークンは含めない）
//       materials/<版>/<パス>       教材のファイル
//     → 新しい iPad や、端末のデータが消えたときに、教材の版と書き込みをそのまま戻せる
//       （配信元の教材が変わっていても、書き込んだときの版が戻る）。
//   ・書き込みだけ（.json）：上の backup.json だけ（小さい）。
//   ・講義ごとの書き出し（講義画面の ⋯、形式 lecture-web-ink）も読み込める。
// =============================================================
import { makeZip, readZip } from './zip.js';
import { LEC_CACHE, verifyVersion } from './download.js';
import { offlineRoot, encodePath, publicSource } from '../content/source.js';
import { importInkData } from '../book.js';
import { INK_FORMAT } from '../config.js';
import { isQuotaError } from '../store.js';

export const BACKUP_FORMAT = 'lecture-web-backup';

export async function createBackup(store, { materials = true, onProgress } = {}) {
  const ink = await store.exportAllInk();
  const library = await store.getLibrary();
  const head = { format: BACKUP_FORMAT, version: 1, createdAt: new Date().toISOString(), source: publicSource(), library, ink };
  if (!materials) return new Blob([JSON.stringify(head)], { type: 'application/json' });
  const files = [{ name: 'backup.json', data: JSON.stringify(head) }];
  for (const rec of library) {
    for (const [v, info] of Object.entries(rec.versions)) {
      if (!(await caches.has(LEC_CACHE(v)))) continue;
      const cache = await caches.open(LEC_CACHE(v));
      for (const f of info.entry.files) {
        const hit = await cache.match(offlineRoot(v) + encodePath(f.path));
        if (hit) files.push({ name: `materials/${v}/${f.path}`, data: await hit.blob() });
      }
    }
  }
  return makeZip(files, onProgress);
}

/** バックアップファイルの中身を調べる（復元前の確認用） */
export async function inspectBackup(file) {
  let head;
  let zip = null;
  const isZip = /\.zip$/i.test(file.name || '') || file.type === 'application/zip' ||
    new Uint8Array(await file.slice(0, 2).arrayBuffer()).join() === '80,75';
  if (isZip) {
    zip = await readZip(file);
    const j = zip.get('backup.json');
    if (!j) throw new Error('バックアップの ZIP ではありません（backup.json がありません）');
    head = JSON.parse(await (await j()).text());
  } else {
    head = JSON.parse(await file.text());
  }
  if (head?.format === INK_FORMAT) {
    return { kind: 'lecture', head, zip, lectures: [head.lecture], summary: `講義「${head.title || head.lecture}」の書き込み` };
  }
  if (head?.format !== BACKUP_FORMAT) throw new Error('このアプリのバックアップファイルではありません');
  const inkIds = Object.keys(head.ink || {});
  const libIds = (head.library || []).map((r) => r.id);
  return {
    kind: zip ? 'full' : 'ink', head, zip, lectures: [...new Set([...inkIds, ...libIds])],
    summary: `${new Date(head.createdAt).toLocaleString('ja-JP')} のバックアップ（書き込み ${inkIds.length} 講義${zip ? `・教材 ${libIds.length} 件` : ''}）`,
  };
}

/**
 * 復元する。書き込みはバックアップに含まれる講義だけ置き換え（他の講義はそのまま）。
 * 教材はバックアップの版を追加（使用中の版はバックアップのものにする）。
 */
export async function restoreBackup(store, info, { onProgress } = {}) {
  const { head, zip } = info;
  if (info.kind === 'lecture') {
    await importInkData(store, head.lecture, head);
    return { lectures: 0, ink: 1 };
  }
  let restored = 0;
  const recs = head.library || [];
  let step = 0;
  for (const rec of recs) {
    onProgress?.(++step, recs.length);
    const versions = {};
    for (const [v, ver] of Object.entries(rec.versions || {})) {
      if (zip) {
        const cache = await caches.open(LEC_CACHE(v));
        for (const f of ver.entry.files) {
          const get = zip.get(`materials/${v}/${f.path}`);
          if (!get) continue;
          const blob = await get();
          try {
            await cache.put(offlineRoot(v) + encodePath(f.path), new Response(blob, {
              headers: { 'Content-Type': blob.type || guessType(f.path), 'Content-Length': String(blob.size), 'X-LW-Hash': f.hash, 'Accept-Ranges': 'bytes' },
            }));
          } catch (e) {
            if (isQuotaError(e)) throw new Error('保存容量が足りません。不要な教材を削除してから復元してください');
            throw e;
          }
        }
      }
      if (await verifyVersion(v, ver.entry)) versions[v] = ver;
    }
    const vs = Object.keys(versions);
    if (!vs.length) continue;
    const existing = await store.getRecord(rec.id);
    const merged = { ...rec, versions: { ...(existing?.versions || {}), ...versions } };
    merged.current = versions[rec.current] ? rec.current
      : existing?.current && merged.versions[existing.current] ? existing.current : vs[vs.length - 1];
    await store.putRecord(merged);
    restored++;
  }
  const ink = Object.entries(head.ink || {});
  for (const [id, d] of ink) await importInkData(store, id, { pages: d.pages || {}, meta: d.meta || {} });
  return { lectures: restored, ink: ink.length };
}

function guessType(path) {
  const ext = (/\.([^./]+)$/.exec(path)?.[1] || '').toLowerCase();
  return { md: 'text/markdown; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', mp4: 'video/mp4',
    json: 'application/json', webp: 'image/webp', gif: 'image/gif', mov: 'video/quicktime' }[ext] || 'application/octet-stream';
}
