---
id: newton-stop
title: ② 止める条件を書く
timeLimit: 3
---
①の更新を最大 100 回くり返します。更新量 $|x_{k+1} - x_k|$ が $10^{-12}$ 未満になったら、$x$ を更新してからくり返しを止める（`break`）ように、`←` の行に `if` 文を書きなさい。
そのまま実行すると 100 回くり返します。止める条件を入れると、何回で止まるでしょうか。

```julia template
a = 2.0
x = 1.0
n = 0                       # くり返した回数
for k in 1:100
    x_new = x - (x^2 - a) / (2x)
    n = k
    # ← ここに「更新量が 1e-12 未満なら、x = x_new としてから break」を書く
    x = x_new
end
println("n = ", n, ",  x = ", x)
```

```julia solution
a = 2.0
x = 1.0
n = 0
for k in 1:100
    x_new = x - (x^2 - a) / (2x)
    n = k
    if abs(x_new - x) < 1e-12
        x = x_new
        break
    end
    x = x_new
end
println("n = ", n, ",  x = ", x)
```

```julia alt name="1 行で書く"
a = 2.0
x = 1.0
n = 0
for k in 1:100
    x_new = x - (x^2 - a) / (2x)
    n = k
    abs(x_new - x) < 1e-12 && (x = x_new; break)
    x = x_new
end
println("n = ", n, ",  x = ", x)
```

```julia test name="止まるまでの回数 n"
n
```

```julia test name="止まったときの x"
x
```

```julia wrong name="不等号が逆（すぐ止まる）"
a = 2.0
x = 1.0
n = 0
for k in 1:100
    x_new = x - (x^2 - a) / (2x)
    n = k
    if abs(x_new - x) > 1e-12
        x = x_new
        break
    end
    x = x_new
end
println("n = ", n, ",  x = ", x)
```

```julia wrong name="止める条件がない"
a = 2.0
x = 1.0
n = 0
for k in 1:100
    x_new = x - (x^2 - a) / (2x)
    n = k
    x = x_new
end
println("n = ", n, ",  x = ", x)
```
