---
id: rk4-order
title: ② 刻み幅を変えて精度を調べる
timeLimit: 5
---
①の計算を関数 `rk4_at1(h)`（刻み幅 $h$ で $t = 1$ まで解いて $x(1)$ を返す）にしてあります。
$h = 0.1,\ 0.05,\ 0.025$ のそれぞれで誤差 $|x(1) - x_{\text{厳密}}|$ を計算し、配列 `errs` に `push!` しなさい（`←` の行）。
4 次の精度なら、$h$ を半分にすると誤差は約 $1/16$ になるはずです。表示される「比」を確かめましょう。

```julia template
f(x, t) = -x + cos(t)
exact = (cos(1) + sin(1)) / 2 + exp(-1) / 2

function rk4_at1(h)
    x = 1.0
    for k in 0:round(Int, 1 / h) - 1
        t = k * h
        k1 = f(x, t)
        k2 = f(x + h / 2 * k1, t + h / 2)
        k3 = f(x + h / 2 * k2, t + h / 2)
        k4 = f(x + h * k3, t + h)
        x = x + h / 6 * (k1 + 2k2 + 2k3 + k4)
    end
    return x
end

errs = Float64[]
for h in [0.1, 0.05, 0.025]
    # ← h ごとの誤差 abs(rk4_at1(h) - exact) を errs に push! する
end
println("誤差: ", errs)
println("比:   ", errs[1:end-1] ./ errs[2:end])
```

```julia solution
f(x, t) = -x + cos(t)
exact = (cos(1) + sin(1)) / 2 + exp(-1) / 2

function rk4_at1(h)
    x = 1.0
    for k in 0:round(Int, 1 / h) - 1
        t = k * h
        k1 = f(x, t)
        k2 = f(x + h / 2 * k1, t + h / 2)
        k3 = f(x + h / 2 * k2, t + h / 2)
        k4 = f(x + h * k3, t + h)
        x = x + h / 6 * (k1 + 2k2 + 2k3 + k4)
    end
    return x
end

errs = Float64[]
for h in [0.1, 0.05, 0.025]
    push!(errs, abs(rk4_at1(h) - exact))
end
println("誤差: ", errs)
println("比:   ", errs[1:end-1] ./ errs[2:end])
```

```julia alt name="内包表記で作る"
f(x, t) = -x + cos(t)
exact = (cos(1) + sin(1)) / 2 + exp(-1) / 2

function rk4_at1(h)
    x = 1.0
    for k in 0:round(Int, 1 / h) - 1
        t = k * h
        k1 = f(x, t)
        k2 = f(x + h / 2 * k1, t + h / 2)
        k3 = f(x + h / 2 * k2, t + h / 2)
        k4 = f(x + h * k3, t + h)
        x = x + h / 6 * (k1 + 2k2 + 2k3 + k4)
    end
    return x
end

errs = [abs(rk4_at1(h) - exact) for h in [0.1, 0.05, 0.025]]
println("誤差: ", errs)
println("比:   ", errs[1:end-1] ./ errs[2:end])
```

```julia test name="誤差が 3 つ入っている" kind=assert
length(errs) == 3
```

```julia test name="誤差の値" rtol=1e-6
errs
```

```julia test name="h を半分にすると誤差が約 1/16（比が 14〜18）" kind=assert
length(errs) == 3 && all(14 .< errs[1:end-1] ./ errs[2:end] .< 18)
```

```julia wrong name="誤差ではなく値を入れた"
f(x, t) = -x + cos(t)
exact = (cos(1) + sin(1)) / 2 + exp(-1) / 2

function rk4_at1(h)
    x = 1.0
    for k in 0:round(Int, 1 / h) - 1
        t = k * h
        k1 = f(x, t)
        k2 = f(x + h / 2 * k1, t + h / 2)
        k3 = f(x + h / 2 * k2, t + h / 2)
        k4 = f(x + h * k3, t + h)
        x = x + h / 6 * (k1 + 2k2 + 2k3 + k4)
    end
    return x
end

errs = Float64[]
for h in [0.1, 0.05, 0.025]
    push!(errs, rk4_at1(h))
end
```
