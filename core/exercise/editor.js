// =============================================================
// 演習のコードエディタ（textarea）の動作：Tab、\alpha → α の変換、⌘Enter / Ctrl+Enter で実行、貼り付けの制限
//
// 貼り付けの制限（paste: false）
//   目的は「自分で入力する」ように促すこと。不正の防止ではない（開発者ツール・自動入力のソフトなどで回避できる）。
//   止める：ほかの場所からの貼り付け（paste）・ドロップ（drop）、それらを経ない貼り付け（beforeinput の insertFromPaste）
//   止めない：エディタの中でコピー・切り取りしたものの貼り付け（行の複製・移動）、エディタの中でのドラッグ、
//            キー入力・日本語入力・Tab と記号の変換
// =============================================================
let latexTable = null;

/** \alpha → α の表（Julia の REPL の表を書き出したもの） */
export function loadLatexTable() {
  if (!latexTable) {
    latexTable = fetch(new URL('./latex-symbols.json', import.meta.url))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return latexTable;
}

export const PASTE_MESSAGE = 'この演習では、ほかの場所からの貼り付けはできません。自分で入力してください（エディタの中でコピーしたものは貼り付けられます）。';

/**
 * @param {HTMLTextAreaElement} ta
 * @param {{ paste: boolean, onRun?: () => void, onBlocked?: () => void, onChange?: () => void }} o
 * @returns {{ expand: () => boolean, setPaste: (allowed: boolean) => void }}
 */
export function attachEditor(ta, o) {
  let paste = !!o.paste;
  let table = {};
  loadLatexTable().then((t) => { table = t || {}; });
  const changed = () => ta.dispatchEvent(new Event('input', { bubbles: true }));

  function expand() {
    const pos = ta.selectionStart;
    const m = /\\[A-Za-z0-9_^]+$/.exec(ta.value.slice(0, pos));
    if (!m || !table[m[0]]) return false;
    ta.setRangeText(table[m[0]], pos - m[0].length, pos, 'end');
    changed();
    return true;
  }

  ta.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); o.onRun?.(); return; }
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (expand()) return;
      ta.setRangeText('    ', ta.selectionStart, ta.selectionEnd, 'end');
      changed();
    }
  });

  // ---- 貼り付けの制限 ----
  const norm = (s) => s.replace(/\r\n?/g, '\n');
  let ownClip = null;      // このエディタでコピー・切り取りした文字列
  let ownDrag = false;     // このエディタの中から始めたドラッグ
  let pasteSeen = false;   // paste イベントを確かめた直後（続く beforeinput を通す）
  const block = (e) => { e.preventDefault(); o.onBlocked?.(); };
  for (const type of ['copy', 'cut']) {
    ta.addEventListener(type, () => { ownClip = norm(ta.value.slice(ta.selectionStart, ta.selectionEnd)); });
  }
  ta.addEventListener('paste', (e) => {
    pasteSeen = true;
    setTimeout(() => { pasteSeen = false; });
    if (paste) return;
    const text = norm(e.clipboardData ? e.clipboardData.getData('text/plain') : '');
    if (text && text === ownClip) return;
    block(e);
  });
  ta.addEventListener('dragstart', () => { ownDrag = true; });
  ta.addEventListener('dragend', () => { ownDrag = false; });
  ta.addEventListener('drop', (e) => { if (!paste && !ownDrag) block(e); });
  ta.addEventListener('beforeinput', (e) => {
    if (paste) return;
    if ((/^insertFromPaste/.test(e.inputType) && !pasteSeen) || (e.inputType === 'insertFromDrop' && !ownDrag)) block(e);
  });

  return { expand, setPaste: (allowed) => { paste = !!allowed; } };
}

/** 入力の誤りのヒント（スマート句読点・全角の記号） */
export function inputHints(code) {
  const hints = [];
  if (/[“”‘’]/.test(code)) hints.push('引用符が “ ” ‘ ’ になっています。" と \' に直してください。');
  const bare = code.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/#.*$/gm, '');
  if (/　/.test(bare)) hints.push('全角の空白が入っています。');
  if (/[（）［］＝＋－＊／，．：；０-９ａ-ｚＡ-Ｚ]/.test(bare)) hints.push('全角の記号・英数字が入っています。半角に直してください。');
  return hints;
}
