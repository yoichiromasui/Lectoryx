---
title: Julia 演習のデモ
course: デモ
lecture: プログラミング演習
date: 2026-11-27
order: 3
---

@page id=title layout=title

# Julia 演習のデモ

## PC の Julia で実行・採点する

::: box 使い方
カードの「開く」で問題・エディタ・採点の画面になります。実行・採点には、PC で **Lectoryx ローカル実行ツール** を起動します（画面の「PC の Julia との接続」）。
iPad では問題とコードを見るだけです。
:::

---

@page id=newton

# ニュートン法

$f(x) = x^2 - a$ の零点を、接線との交点で更新して求める。

$$
x_{k+1} = x_k - \frac{f(x_k)}{f'(x_k)} = x_k - \frac{x_k^2 - a}{2x_k}
$$

@exercise newton

@space 200

---

@page id=rk4

# ルンゲ・クッタ法（RK4）

ソルバーのパッケージを使わず、自分で書いて確かめる。刻み幅 $h$ を半分にすると、誤差は約 $1/16$ になる（4 次の精度）。

@exercise rk4

@space 220

---

@page id=poles

# 2 次系の極

$s^2 + 2\zeta\omega_n s + \omega_n^2 = 0$ の根。$\zeta$ によって、振動的（$\zeta < 1$）・重根（$\zeta = 1$）・過減衰（$\zeta > 1$）に分かれる。

この演習は貼り付けを許可しています（`@exercise poles paste=on`）。

@exercise poles paste=on

@space 160
