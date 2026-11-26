// PDF 読み込みデモの途中に挟んだインタラクティブ教材
export function expDecay(w) {
  const a = w.slider({ label: '$a$', min: 0.2, max: 3, step: 0.1, value: 1 });
  const out = w.output({ in: 'controls', width: 360 });
  const p = w.plot({ width: 560, height: 320, x: [0, 6], y: [0, 1.1], xlabel: '$t$', ylabel: '$f(t)=e^{-at}$' });
  const s = w.plot({ width: 330, height: 320, x: [-3.5, 1], y: [-1.5, 1.5], equal: true, axes: 'cross', xlabel: '$\\mathrm{Re}$', ylabel: '$\\mathrm{Im}$' });
  w.render(() => {
    p.fn((t) => Math.exp(-a.value * t), { color: 'blue', width: 3 });
    s.point(-a.value, 0, { color: 'red', radius: 7, label: '$-a$', anchor: 'n' });
    out.tex(`F(s) = \\dfrac{1}{s + ${a.value.toFixed(1)}}`);
  });
}
