// lecture.md の「@widget example」に対応する。API は CLAUDE.md の「ウィジェット API」を参照。
export function example(w) {
  const a = w.slider({ label: '$a$', min: -2, max: 2, step: 0.1, value: 1 });
  const p = w.plot({ x: [-3, 3], y: [-1, 5], xlabel: '$x$', ylabel: '$y$', height: 320 });
  w.render(() => {
    p.fn((x) => a.value * x * x, { label: `$y = ${a.value.toFixed(1)}\\,x^2$` });
  });
}
