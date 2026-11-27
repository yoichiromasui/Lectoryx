---
id: rk4-fill
title: ① RK4 の k3・k4 を書く
timeLimit: 5
---
$\dot{x} = -x + \cos t,\ x(0) = 1$ を、刻み幅 $h = 0.1$ の 4 次のルンゲ・クッタ法で $t = 1$ まで解きます。
$k_1, k_2$ と更新式は書いてあります。`←` の 2 行に $k_3, k_4$ を書きなさい。

$$
k_3 = f\!\left(x_k + \tfrac{h}{2} k_2,\ t_k + \tfrac{h}{2}\right), \qquad k_4 = f(x_k + h k_3,\ t_k + h)
$$

厳密解は $x(t) = \tfrac{1}{2}(\cos t + \sin t) + \tfrac{1}{2} e^{-t}$ です。誤差がどこまで小さくなるかを見ましょう。

```julia template
f(x, t) = -x + cos(t)
h = 0.1
x = 1.0                       # x(0)
for k in 0:9                  # t = 0 から 1 まで 10 ステップ
    t = k * h
    k1 = f(x, t)
    k2 = f(x + h / 2 * k1, t + h / 2)
    k3 = 0.0                  # ← k3 を書く
    k4 = 0.0                  # ← k4 を書く
    x = x + h / 6 * (k1 + 2k2 + 2k3 + k4)
end
exact = (cos(1) + sin(1)) / 2 + exp(-1) / 2
println("RK4: ", x, "   厳密解: ", exact, "   誤差: ", abs(x - exact))
```

```julia solution
f(x, t) = -x + cos(t)
h = 0.1
x = 1.0
for k in 0:9
    t = k * h
    k1 = f(x, t)
    k2 = f(x + h / 2 * k1, t + h / 2)
    k3 = f(x + h / 2 * k2, t + h / 2)
    k4 = f(x + h * k3, t + h)
    x = x + h / 6 * (k1 + 2k2 + 2k3 + k4)
end
exact = (cos(1) + sin(1)) / 2 + exp(-1) / 2
println("RK4: ", x, "   厳密解: ", exact, "   誤差: ", abs(x - exact))
```

```julia test name="t = 1 での x"
x
```

```julia test name="誤差が 1e-6 より小さい（4 次の精度）" kind=assert
abs(x - exact) < 1e-6
```

```julia wrong name="k3 の時刻を t のままにした"
f(x, t) = -x + cos(t)
h = 0.1
x = 1.0
for k in 0:9
    t = k * h
    k1 = f(x, t)
    k2 = f(x + h / 2 * k1, t + h / 2)
    k3 = f(x + h / 2 * k2, t)
    k4 = f(x + h * k3, t + h)
    x = x + h / 6 * (k1 + 2k2 + 2k3 + k4)
end
exact = (cos(1) + sin(1)) / 2 + exp(-1) / 2
```

```julia wrong name="k4 で h/2 を使った"
f(x, t) = -x + cos(t)
h = 0.1
x = 1.0
for k in 0:9
    t = k * h
    k1 = f(x, t)
    k2 = f(x + h / 2 * k1, t + h / 2)
    k3 = f(x + h / 2 * k2, t + h / 2)
    k4 = f(x + h / 2 * k3, t + h)
    x = x + h / 6 * (k1 + 2k2 + 2k3 + k4)
end
exact = (cos(1) + sin(1)) / 2 + exp(-1) / 2
```
