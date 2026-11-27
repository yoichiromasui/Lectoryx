---
id: poles
title: 2 次系の極を求める
timeLimit: 5
---
2 次系の特性方程式 $s^2 + 2\zeta\omega_n s + \omega_n^2 = 0$ の解（極）を、解の公式で `p1`（$-\sqrt{D}$ の方）と `p2`（$+\sqrt{D}$ の方）に入れなさい（`←` の 2 行）。
判別式 `D` は、負になっても計算できるように `complex(…)` で複素数にしてあります。
最後の行は、解と係数の関係（積 $= \omega_n^2$、和 $= -2\zeta\omega_n$）の確認です。$\zeta$ を 0・1・2 に変えて、極がどう動くかも試しましょう。

```julia template
ζ = 0.5
ωn = 1.0
b = 2ζ * ωn
D = complex(b^2 - 4ωn^2)      # 判別式（複素数）
p1 = 0.0                      # ← -√D の方の極
p2 = 0.0                      # ← +√D の方の極
println("p1 = ", p1, ",  p2 = ", p2)
println("積 = ", p1 * p2, ",  和 = ", p1 + p2)
```

```julia solution
ζ = 0.5
ωn = 1.0
b = 2ζ * ωn
D = complex(b^2 - 4ωn^2)
p1 = (-b - sqrt(D)) / 2
p2 = (-b + sqrt(D)) / 2
println("p1 = ", p1, ",  p2 = ", p2)
println("積 = ", p1 * p2, ",  和 = ", p1 + p2)
```

```julia alt name="b を使わずに書く"
ζ = 0.5
ωn = 1.0
b = 2ζ * ωn
D = complex(b^2 - 4ωn^2)
p1 = -ζ * ωn - sqrt(D) / 2
p2 = -ζ * ωn + sqrt(D) / 2
```

```julia test name="p1（虚部が負の方）"
p1
```

```julia test name="p2（虚部が正の方）"
p2
```

```julia test name="解と係数の関係（積 = ωn²、和 = −2ζωn）" kind=assert
p1 * p2 ≈ ωn^2 && p1 + p2 ≈ -2ζ * ωn
```

```julia wrong name="2 で割り忘れた"
ζ = 0.5
ωn = 1.0
b = 2ζ * ωn
D = complex(b^2 - 4ωn^2)
p1 = -b - sqrt(D)
p2 = -b + sqrt(D)
```

```julia wrong name="複素数にせずに sqrt した（DomainError）"
ζ = 0.5
ωn = 1.0
b = 2ζ * ωn
D = b^2 - 4ωn^2
p1 = (-b - sqrt(D)) / 2
p2 = (-b + sqrt(D)) / 2
```
