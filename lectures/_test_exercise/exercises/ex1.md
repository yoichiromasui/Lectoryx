---
id: ex1
title: テスト用の演習
timeLimit: 3
---
$f(x) = 2x$ を返す関数 `f(x)` を作りなさい。

```julia template
function f(x)
    # ここに書く
end
```

```julia solution
f(x) = 2x
```

```julia test name="f(3)"
f(3)
```

```julia test name="f(0.5)"
f(0.5)
```

```julia wrong name="2 乗している"
f(x) = x^2
```
