---
id: rk4
title: ルンゲ・クッタ法（RK4）で微分方程式を解く
timeLimit: 5
---
微分方程式 $\dot{x} = f(x, t)$ を、刻み幅 $h$ の 4 次のルンゲ・クッタ法で $t_0$ から $t_1$ まで解き、$t = t_1$ での $x$ を返す関数 `rk4(f, x0, t0, t1, h)` を作りなさい。
$x$ はベクトル、`f(x, t)` は $\dot{x}$（ベクトル）を返します。ステップ数は `round(Int, (t1 - t0) / h)` とします。

$$
\begin{aligned}
k_1 &= f(x_k,\ t_k), & k_2 &= f\!\left(x_k + \tfrac{h}{2} k_1,\ t_k + \tfrac{h}{2}\right),\\
k_3 &= f\!\left(x_k + \tfrac{h}{2} k_2,\ t_k + \tfrac{h}{2}\right), & k_4 &= f(x_k + h k_3,\ t_k + h),\\
x_{k+1} &= x_k + \tfrac{h}{6}\,(k_1 + 2k_2 + 2k_3 + k_4)
\end{aligned}
$$

```julia template
function rk4(f, x0, t0, t1, h)
    x = copy(x0)
    n = round(Int, (t1 - t0) / h)
    for k in 0:n-1
        t = t0 + k * h
        # ここに書く
    end
    return x
end
```

```julia solution
function rk4(f, x0, t0, t1, h)
    x = copy(x0)
    n = round(Int, (t1 - t0) / h)
    for k in 0:n-1
        t = t0 + k * h
        k1 = f(x, t)
        k2 = f(x + h / 2 * k1, t + h / 2)
        k3 = f(x + h / 2 * k2, t + h / 2)
        k4 = f(x + h * k3, t + h)
        x = x + h / 6 * (k1 + 2k2 + 2k3 + k4)
    end
    return x
end
```

```julia alt name="時刻を t += h で進める"
function rk4(f, x0, t0, t1, h)
    x = copy(x0)
    t = t0
    for _ in 1:round(Int, (t1 - t0) / h)
        k1 = f(x, t)
        k2 = f(x .+ (h / 2) .* k1, t + h / 2)
        k3 = f(x .+ (h / 2) .* k2, t + h / 2)
        k4 = f(x .+ h .* k3, t + h)
        x = x .+ (h / 6) .* (k1 .+ 2 .* k2 .+ 2 .* k3 .+ k4)
        t += h
    end
    return x
end
```

```julia test name="1 次系 ẋ = −x（解は e^{−t}）"
rk4((x, t) -> -x, [1.0], 0.0, 1.0, 0.01)
```

```julia test name="単振動（解は cos t, −sin t）"
rk4((x, t) -> [x[2], -x[1]], [1.0, 0.0], 0.0, 2π, 0.01)
```

```julia test name="時刻に依存する式 ẋ = cos t"
rk4((x, t) -> [cos(t)], [0.0], 0.0, 1.0, 0.1)
```

```julia test name="4 次の精度（刻みを半分にすると誤差が約 1/16）" kind=assert
e(h) = abs(rk4((x, t) -> -x, [1.0], 0.0, 1.0, h)[1] - exp(-1))
12 < e(0.1) / e(0.05) < 20
```

```julia test name="飽和のある振り子" hidden
rk4((x, t) -> [x[2], -sin(x[1]) - 0.2x[2] + clamp(-2x[1], -0.5, 0.5)], [1.0, 0.0], 0.0, 20.0, 0.01)
```

```julia wrong name="オイラー法になっている"
function rk4(f, x0, t0, t1, h)
    x = copy(x0)
    n = round(Int, (t1 - t0) / h)
    for k in 0:n-1
        x = x + h * f(x, t0 + k * h)
    end
    return x
end
```

```julia wrong name="k2・k3 の時刻を t のままにした"
function rk4(f, x0, t0, t1, h)
    x = copy(x0)
    n = round(Int, (t1 - t0) / h)
    for k in 0:n-1
        t = t0 + k * h
        k1 = f(x, t)
        k2 = f(x + h / 2 * k1, t)
        k3 = f(x + h / 2 * k2, t)
        k4 = f(x + h * k3, t + h)
        x = x + h / 6 * (k1 + 2k2 + 2k3 + k4)
    end
    return x
end
```
