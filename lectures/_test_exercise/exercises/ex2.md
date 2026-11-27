---
id: ex2
title: 教材の環境を使う演習
timeLimit: 5
env: linalg
---
行列 $A$ の固有値を小さい順に並べたベクトルを返す関数 `ev(A)` を作りなさい（教材の環境 linalg：LinearAlgebra）。

```julia template
using LinearAlgebra
function ev(A)
    # ここに書く
end
```

```julia solution
using LinearAlgebra
ev(A) = sort(eigvals(A))
```

```julia test name="対称行列"
ev([2.0 1.0; 1.0 2.0])
```

```julia test name="上三角" kind=assert
ev([1.0 5.0; 0.0 -3.0]) ≈ [-3.0, 1.0]
```

```julia wrong name="並べていない"
using LinearAlgebra
ev(A) = reverse(sort(eigvals(A)))
```
