// ファイルの保存（iPad は共有シート →「ファイルに保存」、PC はダウンロード）と選択
import { h, isAppleTouchDevice } from '../util.js';

/** @returns {Promise<boolean>} 保存（または共有シートを表示）したか */
export async function saveFile(blob, name) {
  if (isAppleTouchDevice() && navigator.canShare) {
    const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return true;
      } catch (e) {
        if (e.name === 'AbortError') return false;
        // 共有できない（ユーザー操作の外など）→ ダウンロードにする
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

/** ファイルを選ばせる（キャンセルなら null） */
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const f = input.files?.[0] || null;
      input.remove();
      resolve(f);
    });
    input.click();
  });
}

/** 「YYYYMMDD」 */
export function dateStamp(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
