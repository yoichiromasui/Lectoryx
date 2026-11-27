// =============================================================
// 教材のページに置く演習のカード（@exercise <id>）
//   ページの中は大きさ固定のカード（種類・題名・進み具合・「開く」）だけにし、問題文・エディタ・出力・採点は
//   ページの上に重ねるシート（sheet.js。開いたときに読み込む）で扱う。
//   カードの中身（題名・進み具合）が変わってもカードの大きさは変わらないので、書き込みとずれない。
//
// 貼り付けの制限（どれか 1 か所に書く。下ほど優先）
//   既定                                ：貼り付けできない
//   lecture.md のフロントマター paste: on / off   ：その講義の演習すべて
//   @exercise <id> paste=on / off        ：その演習だけ
// =============================================================
import { h } from '../util.js';

const ON = new Set([true, 'on', 'true', 'yes', 'allow']);
const OFF = new Set([false, 'off', 'false', 'no', 'deny']);

/** 貼り付けを許すか（true なら貼り付けできる） */
export function pasteAllowed(lecture, attr) {
  for (const v of [attr, lecture?.meta?.paste]) {
    if (ON.has(v)) return true;
    if (OFF.has(v)) return false;
  }
  return false;
}

/** 進み具合の表示（カードとシートで共通） */
export function statusText(rec) {
  if (!rec) return '未着手';
  if (rec.total) return rec.passed === rec.total ? `合格（${rec.passed} / ${rec.total}）` : `${rec.passed} / ${rec.total} 合格`;
  return rec.code ? '書きかけ' : '未着手';
}

/**
 * @param {Element} root  ページの教材要素
 * @param {{ lecture, get(id), set(id, rec) }} ctx  rec = { code, passed, total, at } はページの state.exercises に保存
 */
export function mountExercises(root, ctx) {
  for (const el of root.querySelectorAll('.lw-exercise[data-exercise]')) {
    const id = el.dataset.exercise;
    const ex = ctx.lecture.exercises?.[id];
    const status = h('div', { class: 'lw-ex-card-status' });
    const update = () => {
      const rec = ctx.get(id);
      status.textContent = ex?.error ? '読み込めません' : statusText(rec);
      el.classList.toggle('lw-ex-done', !!rec?.total && rec.passed === rec.total);
    };
    const open = () => {
      if (!ex || ex.error) return;
      import('./sheet.js').then((m) => m.openExercise({
        id, ex, lecture: ctx.lecture,
        paste: pasteAllowed(ctx.lecture, el.dataset.paste),
        get: () => ctx.get(id),
        set: (rec) => { ctx.set(id, rec); update(); },
      })).catch((e) => console.error(e));
    };
    el.textContent = '';
    el.append(
      h('div', { class: 'lw-ex-card-main' },
        h('div', { class: 'lw-ex-card-kind' }, 'Julia 演習'),
        h('div', { class: 'lw-ex-card-title' }, ex && !ex.error ? ex.title : `演習「${id}」`),
        status),
      h('button', { class: 'lw-ex-card-open', type: 'button', disabled: !ex || !!ex.error, onclick: open }, '開く'),
    );
    if (ex?.error) el.title = ex.error;
    update();
  }
}
