// =============================================================
// Undo / Redo（ページ単位）
//
// 操作 op = { removed:[{i, s}], added:[{i, s}], extra?:[before, after], texts?:[{i, a, b}] }
//   removed: 操作前の配列での位置 i とストローク
//   added  : 操作後の配列での位置 i とストローク
//   texts  : テキストの変更（a: 変更前, b: 変更後。null は「なし」。i は配列での位置）
// LIFO で適用するので、記録した位置は適用時の状態と常に一致する。
// =============================================================
import { HISTORY_LIMIT } from '../config.js';
import { strokeBounds } from './stroke.js';
import { rect } from '../util.js';

/** 2 つのストローク配列の差分から op を作る */
export function diffStrokes(before, after) {
  const afterIds = new Set(after.map((s) => s.id));
  const beforeIds = new Set(before.map((s) => s.id));
  const removed = [];
  const added = [];
  before.forEach((s, i) => { if (!afterIds.has(s.id)) removed.push({ i, s }); });
  after.forEach((s, i) => { if (!beforeIds.has(s.id)) added.push({ i, s }); });
  return { removed, added };
}

export function isEmptyOp(op) {
  return !op.removed.length && !op.added.length && !(op.extra && op.extra[0] !== op.extra[1]) &&
    !(op.texts && op.texts.length);
}

/** op の影響範囲（再描画領域） */
export function opBounds(op) {
  let b = null;
  for (const e of op.removed) b = rect.union(b, strokeBounds(e.s));
  for (const e of op.added) b = rect.union(b, strokeBounds(e.s));
  return b;
}

function applyChange(strokes, remove, insert) {
  if (remove.length) {
    const ids = new Set(remove.map((e) => e.s.id));
    let w = 0;
    for (let r = 0; r < strokes.length; r++) if (!ids.has(strokes[r].id)) strokes[w++] = strokes[r];
    strokes.length = w;
  }
  for (const e of insert) strokes.splice(Math.min(e.i, strokes.length), 0, e.s);
}

/** テキストの変更を適用（forward=false で元に戻す）。複数の変更は位置の昇順で記録すること */
function applyTexts(texts, changes, forward) {
  for (const ch of changes) {
    const to = forward ? ch.b : ch.a;
    const id = (ch.a || ch.b).id;
    const k = texts.findIndex((t) => t.id === id);
    if (to) {
      if (k >= 0) texts[k] = to;
      else texts.splice(Math.min(ch.i, texts.length), 0, to);
    } else if (k >= 0) {
      texts.splice(k, 1);
    }
  }
}

export class History {
  constructor(limit = HISTORY_LIMIT) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }
  push(op) {
    if (isEmptyOp(op)) return;
    this.undoStack.push(op);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** state = { strokes, extra, texts } を書き換え、適用した op を返す */
  undo(state) {
    const op = this.undoStack.pop();
    if (!op) return null;
    applyChange(state.strokes, op.added, op.removed);
    if (op.extra) state.extra = op.extra[0];
    if (op.texts) applyTexts(state.texts, op.texts, false);
    this.redoStack.push(op);
    return op;
  }
  redo(state) {
    const op = this.redoStack.pop();
    if (!op) return null;
    applyChange(state.strokes, op.removed, op.added);
    if (op.extra) state.extra = op.extra[1];
    if (op.texts) applyTexts(state.texts, op.texts, true);
    this.undoStack.push(op);
    return op;
  }
  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
