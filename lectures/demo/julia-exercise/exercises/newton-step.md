---
id: newton-step
title: ① ニュートン法の更新式を書く
timeLimit: 3
---
$\sqrt{a}$ を求めるニュートン法の更新式
$$
x_{k+1} = x_k - \frac{x_k^2 - a}{2x_k}
$$
を、`←` の行の右辺に書きなさい（ほかの行はそのままでよい）。まず一度そのまま実行して、$x$ が変わらないことを確かめてから書き換えましょう。

```julia template
a = 2.0          # √a を求める
x = 1.0          # 初期値 x₀
for k in 1:5
    x = x        # ← 右辺を、ニュートン法の更新式に書き換える
    println(k, ": ", x)
end
```

```julia solution
a = 2.0
x = 1.0
for k in 1:5
    x = x - (x^2 - a) / (2x)
    println(k, ": ", x)
end
```

```julia alt name="式を整理した形"
a = 2.0
x = 1.0
for k in 1:5
    x = (x + a / x) / 2
    println(k, ": ", x)
end
```

```julia test name="5 回くり返した後の x"
x
```

```julia test name="x² が a にほぼ等しい" kind=assert
abs(x^2 - a) < 1e-12
```

```julia wrong name="分母の 2 を忘れた"
a = 2.0
x = 1.0
for k in 1:5
    x = x - (x^2 - a) / x
    println(k, ": ", x)
end
```

```julia wrong name="書き換えていない"
a = 2.0
x = 1.0
for k in 1:5
    x = x
    println(k, ": ", x)
end
```
