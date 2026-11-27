---
id: newton
title: ニュートン法で平方根を求める
timeLimit: 3
---
$a > 0$ の平方根を、ニュートン法
$$
x_{k+1} = x_k - \frac{x_k^2 - a}{2x_k}
$$
で求める関数 `newton_sqrt(a; tol=1e-12)` を作りなさい。初期値は $x_0 = \max(a, 1)$ とし、更新量 $|x_{k+1} - x_k|$ が `tol` 未満になったら終了します。
$a < 0$ のときは `DomainError` を投げること（`throw(DomainError(a, "負の数"))`）。$a = 0$ なら $0$ を返します。

```julia template
function newton_sqrt(a; tol=1e-12)
    # ここに書く
end
```

```julia solution
function newton_sqrt(a; tol=1e-12)
    a < 0 && throw(DomainError(a, "負の数"))
    a == 0 && return 0.0
    x = max(a, 1.0)
    while true
        x_new = x - (x^2 - a) / (2x)
        if abs(x_new - x) < tol
            return x_new
        end
        x = x_new
    end
end
```

```julia test name="√2"
newton_sqrt(2.0)
```

```julia test name="√9"
newton_sqrt(9)
```

```julia test name="小さい数 √(1e-6)" rtol=1e-6
newton_sqrt(1e-6)
```

```julia test name="大きい数 √(1e6)"
newton_sqrt(1e6)
```

```julia test name="2 乗すると元に戻る" kind=assert
all(newton_sqrt(a)^2 ≈ a for a in [0.5, 3.0, 10.0, 123.0])
```

```julia test name="ゼロ"
newton_sqrt(0.0)
```

```julia test name="負の数は DomainError" kind=error
newton_sqrt(-1.0)
```

```julia wrong name="終了条件が厳しすぎて止まらない（無限ループ）"
function newton_sqrt(a; tol=1e-12)
    a < 0 && throw(DomainError(a, "負の数"))
    x = max(a, 1.0)
    while x^2 != a
        x = x - (x^2 - a) / (2x)
    end
    return x
end
```

```julia wrong name="負の数のチェックがない"
function newton_sqrt(a; tol=1e-12)
    a == 0 && return 0.0
    x = max(a, 1.0)
    for k in 1:100
        x = x - (x^2 - a) / (2x)
    end
    return x
end
```
