// 一次遅れ系のインタラクティブ教材
// lecture.md の「@widget 関数名」に対応する関数を export する。API は CLAUDE.md 参照。

/** 一次遅れ系の単位ステップ応答 y(t) = K(1 - e^{-t/T}) */
const step = (K, T) => (t) => (t < 0 ? 0 : K * (1 - Math.exp(-t / T)));

/** 時定数・ゲインを変えたときのステップ応答 */
export function stepResponse(w) {
  const T = w.slider({ label: '時定数 $T$', min: 0.2, max: 5, step: 0.1, value: 1, unit: 's' });
  const K = w.slider({ label: 'ゲイン $K$', min: 0.5, max: 2, step: 0.1, value: 1 });
  w.br();
  const tangent = w.checkbox({ label: '接線', value: true });
  const mark = w.checkbox({ label: '$63.2\\%$ の点', value: true });
  const ref = w.checkbox({ label: '$T=1,\\ K=1$ と比較', value: false });
  const eq = w.output({ in: 'controls', width: 330 });
  const p = w.plot({ x: [0, 10], y: [0, 2.2], xlabel: '時間 $t$ [s]', ylabel: '出力 $y(t)$', height: 330 });

  w.render(() => {
    const t = T.value;
    const k = K.value;
    if (ref.value) p.fn(step(1, 1), { color: 'gray', dash: true, width: 2, label: '$T=1,\\ K=1$' });
    p.hline(k, { dash: [4, 4] });
    p.fn(step(k, t), { color: 'blue', width: 3, label: '$y(t)$' });
    if (tangent.value) p.segment(0, 0, t, k, { color: 'red', dash: true, width: 2 });
    if (mark.value) {
      const y = k * (1 - Math.exp(-1));
      p.segment(t, 0, t, y, { color: 'gray', dash: [3, 4], width: 1.2 });
      p.point(t, y, { color: 'red', radius: 6, label: '$0.632K$', anchor: 'se' });
      p.label(t, 0, '$T$', { anchor: 'n', color: 'red' });
    }
    eq.tex(`y(t) = ${k.toFixed(1)}\\left(1 - e^{-t/${t.toFixed(1)}}\\right)`);
  });
}

/** 複素平面上の極をドラッグ → ステップ応答が変わる */
export function poleStep(w) {
  const { fmt } = w.math;
  const info = w.output({ in: 'controls' });
  const plane = w.plot({
    width: 380, height: 330, x: [-4, 1], y: [-2.2, 2.2],
    equal: true, axes: 'cross', xlabel: '$\\mathrm{Re}$', ylabel: '$\\mathrm{Im}$',
  });
  const resp = w.plot({ width: 510, height: 330, x: [0, 8], y: [0, 1.2], xlabel: '$t$ [s]', ylabel: '$y(t)$' });
  const pole = plane.handle({
    x: -1, y: 0, color: 'red', label: '$-1/T$',
    constrain: (x) => [Math.min(-0.2, Math.max(-4, x)), 0],
  });

  w.render(() => {
    const s = pole.x;
    const T = -1 / s;
    plane.rect(plane.vx[0], plane.vy[0], 0, plane.vy[1], { fill: 'green', fillAlpha: 0.07, stroke: false });
    plane.label(-3.2, 1.7, '安定（左半平面）', { anchor: 'c', color: 'green', size: 16 });
    resp.hline(1, { dash: [4, 4] });
    resp.fn((t) => 1 - Math.exp(s * t), { color: 'blue', width: 3 });
    resp.point(T, 1 - Math.exp(-1), { color: 'red', label: '$t = T$', anchor: 'se' });
    info.tex(`s = ${fmt(s)} \\quad\\Longrightarrow\\quad T = -\\frac{1}{s} = ${fmt(T)}\\ \\mathrm{s}`);
  });
}

/** タンクの水位のアニメーション（再生・停止・リセット） */
export function tankAnimation(w) {
  const anim = w.animation({ duration: 12, label: '注水' });
  w.select({ label: '速さ', options: { '×0.5': 0.5, '×1': 1, '×2': 2 }, value: 1 })
    .onChange((v) => { anim.speed = v; });
  w.br();
  const T = w.slider({ label: '時定数 $T$', min: 0.5, max: 4, step: 0.1, value: 2, unit: 's' });
  const tank = w.canvas({ width: 250, height: 330 });
  const p = w.plot({ width: 640, height: 330, x: [0, 12], y: [0, 1.15], xlabel: '$t$ [s]', ylabel: '水位 $h(t)/h_\\infty$' });

  w.render(() => {
    const t = anim.t;
    const tau = T.value;
    const level = 1 - Math.exp(-t / tau);
    drawTank(tank.ctx, level, anim.playing || (t > 0 && t < 12));
    p.hline(1, { dash: [4, 4] });
    p.fn((x) => 1 - Math.exp(-x / tau), { color: 'gray', dash: true, width: 1.5 });
    if (t > 0) p.fn((x) => 1 - Math.exp(-x / tau), { domain: [0, t], color: 'blue', width: 3 });
    p.point(t, level, { color: 'blue', radius: 6 });
  });
}

function drawTank(c, level, flowing) {
  const x0 = 45, x1 = 205, top = 70, bottom = 300;
  const maxH = bottom - top - 25;
  // 水
  const hgt = maxH * level;
  c.fillStyle = '#9cc7f5';
  c.fillRect(x0, bottom - hgt, x1 - x0, hgt);
  c.fillStyle = '#5b9be8';
  c.fillRect(x0, bottom - hgt, x1 - x0, Math.min(4, hgt));
  // 注水
  c.strokeStyle = '#4a4f5a';
  c.lineWidth = 6;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(15, 30);
  c.lineTo(90, 30);
  c.lineTo(90, 52);
  c.stroke();
  if (flowing) {
    c.fillStyle = '#5b9be8';
    c.fillRect(85, 55, 10, bottom - hgt - 55);
  }
  // タンク
  c.lineWidth = 4;
  c.strokeStyle = '#2a2e36';
  c.beginPath();
  c.moveTo(x0, top);
  c.lineTo(x0, bottom);
  c.lineTo(x1, bottom);
  c.lineTo(x1, top);
  c.stroke();
  // 流出管
  c.lineWidth = 6;
  c.strokeStyle = '#4a4f5a';
  c.beginPath();
  c.moveTo(x1, bottom - 12);
  c.lineTo(240, bottom - 12);
  c.stroke();
  // 目盛り
  c.fillStyle = '#2a2e36';
  c.font = '16px "KaTeX_Main", serif';
  c.fillText(`h = ${level.toFixed(2)}`, x0 + 8, top + 10);
}
