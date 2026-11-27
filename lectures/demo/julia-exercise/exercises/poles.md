---
id: poles
title: 2 次系の極
timeLimit: 5
---
2 次系 $G(s) = \dfrac{\omega_n^2}{s^2 + 2\zeta\omega_n s + \omega_n^2}$ の極（分母 $=0$ の根）を求める関数 `poles(ζ, ωn)` を作りなさい。
戻り値は 2 つの極を **虚部の小さい順**（虚部が同じなら実部の小さい順）に並べた複素数のベクトルとします。
ヒント：判別式 `D` を `sqrt(complex(D))` で計算する。並べ替えは `sort(sort(p, by = real), by = imag)`（実部で並べてから虚部で並べる）。

```julia template
function poles(ζ, ωn)
    # ここに書く
end
```

```julia solution
function poles(ζ, ωn)
    b = 2ζ * ωn
    D = complex(b^2 - 4ωn^2)
    p = [(-b - sqrt(D)) / 2, (-b + sqrt(D)) / 2]
    return sort(sort(p, by = real), by = imag)
end
```

```julia alt name="タプルをキーにして 1 回で並べる"
function poles(ζ, ωn)
    b = 2ζ * ωn
    D = complex(b^2 - 4ωn^2)
    p = [(-b - sqrt(D)) / 2, (-b + sqrt(D)) / 2]
    return sort(p, by = z -> (imag(z), real(z)))
end
```

```julia alt name="状態行列の固有値（複素数にそろえる）"
using LinearAlgebra
function poles(ζ, ωn)
    A = [0.0 1.0; -ωn^2 -2ζ * ωn]
    p = eigvals(A)
    return sort(sort(complex.(p), by = real), by = imag)
end
```

```julia alt name="状態行列の固有値（そのまま並べる）"
using LinearAlgebra
function poles(ζ, ωn)
    A = [0.0 1.0; -ωn^2 -2ζ * ωn]
    return sort(sort(eigvals(A), by = real), by = imag)
end
```

```julia test name="ζ = 0.5, ωn = 1（振動的）"
poles(0.5, 1.0)
```

```julia test name="ζ = 0（持続振動）" atol=1e-9
poles(0.0, 3.0)
```

```julia test name="ζ = 2（過減衰：実数の極 2 つ）" atol=1e-9
poles(2.0, 1.0)
```

```julia test name="ζ = 1（重根）" rtol=1e-6 atol=1e-6
poles(1.0, 2.0)
```

```julia test name="極の積は ωn²、和は −2ζωn" kind=assert
p = poles(0.3, 5.0)
prod(p) ≈ 25 && sum(p) ≈ -3.0
```

```julia wrong name="並べ方が逆"
function poles(ζ, ωn)
    D = complex((2ζ * ωn)^2 - 4ωn^2)
    return [(-2ζ * ωn + sqrt(D)) / 2, (-2ζ * ωn - sqrt(D)) / 2]
end
```
