// tests/smoke.html 用のウィジェット
export function probe(w) {
  const a = w.slider({ label: '$a$', min: 0, max: 1, step: 0.1, value: 0.5 });
  const p = w.plot({ x: [0, 1], y: [0, 1], width: 400, height: 240 });
  const hd = p.handle({ x: 0.5, y: 0.5 });
  let renders = 0;
  w.render(() => {
    renders++;
    p.fn((x) => a.value * x);
  });
  window.__probe = { a, p, hd, w, get renders() { return renders; } };
}
