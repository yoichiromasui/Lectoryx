---
title: 一次遅れ系の応答（デモ）
course: デモ
lecture: 手書き・数式・数値実験
date: 2026-11-26
order: 1
blankBg: grid
macros:
  \dd: \mathrm{d}
  \Lap: \mathcal{L}
  \e: \mathrm{e}
---

@page id=title layout=title

# 一次遅れ系の応答

## Lectoryx デモ

::: box 今日の目標
- 一次遅れ系の**微分方程式**と**伝達関数**を導く
- ステップ応答の解析解を求める
- *時定数* $T$ が応答の速さを決めることを確かめる
:::

---

@page id=intro

# 一次遅れ系とは

::: cols 3:2
::: col
次のような現象は、同じ形の微分方程式で表される。

- RC 回路のコンデンサ電圧
- タンクの水位
- 物体の温度（ニュートンの冷却則）
- 直流モータの回転速度

入力を急に変えても出力は**すぐには**追従せず、*遅れて*目標値に近づいていく。
:::
::: col
@image media/rc-circuit.svg width=360 height=240 caption="RC 回路"
:::
:::

---

@page id=ode

# 一次遅れ系の微分方程式

入力 $u(t)$、出力 $y(t)$ の一次遅れ系は

$$
T\frac{\dd y(t)}{\dd t} + y(t) = K\,u(t)
$$

::: def
- $T\ (>0)$ : **時定数**（time constant）[s]
- $K$ : **ゲイン**（定常ゲイン）
:::

::: ex RC 回路の場合
キルヒホッフの電圧則 $v_{\mathrm{in}} = R\,i + v_C$ と $i = C\dfrac{\dd v_C}{\dd t}$ より

$$
RC\,\frac{\dd v_C}{\dd t} + v_C = v_{\mathrm{in}}
\qquad\Longrightarrow\qquad T = RC,\quad K = 1
$$
:::

---

@page id=tf

# 伝達関数の導出

初期値を $y(0)=0$ として両辺をラプラス変換する。

$\Lap\!\left[\dfrac{\dd y}{\dd t}\right] = sY(s) - y(0)$ を用いると

$$
T\,sY(s) + Y(s) = K\,U(s)
$$

@space 170 box

::: point 一次遅れ系の伝達関数
$$
G(s) = \frac{Y(s)}{U(s)} = \frac{K}{Ts + 1}
$$
:::

---

@page id=step-analytic

# ステップ応答の解析解

単位ステップ入力 $u(t) = 1\ (t \ge 0)$、すなわち $U(s) = \dfrac{1}{s}$ に対して

$$
Y(s) = G(s)U(s) = \frac{K}{s\,(Ts+1)} = K\left(\frac{1}{s} - \frac{1}{s + 1/T}\right)
$$

逆ラプラス変換すると

$$
y(t) = K\left(1 - \e^{-t/T}\right) \qquad (t \ge 0)
$$

::: cols
::: col
::: point 時定数 $T$ の意味
- $y(T) = K(1-\e^{-1}) \approx 0.632\,K$
- $t=0$ での接線の傾きは $K/T$
- $t = 4T$ で最終値の約 $98\%$
:::
:::
::: col
@space 210 box
:::
:::

---

@page id=step-interactive

# 時定数を変えてみる

$T$ と $K$ を動かして、$t=T$ で $63.2\%$ に達する点と接線の関係を確かめよう。

@widget stepResponse

---

@page id=pole

# 極の位置と応答の速さ

$G(s) = \dfrac{K}{Ts+1}$ の極は $s = -\dfrac{1}{T}$。赤い点（極）を指でドラッグしてみよう。

@widget poleStep

---

@page id=tank

# アニメーション：タンクの水位

一定流量で水を注ぐと、水位は一次遅れで上昇する（$T$：断面積 × 流出抵抗）。

@widget tankAnimation

---

@page id=board bg=grid

# 板書スペース

---

@page id=summary

# まとめと演習

| | 一次遅れ系 |
|:--|:--|
| 微分方程式 | $T\dot y + y = K u$ |
| 伝達関数 | $G(s) = \dfrac{K}{Ts+1}$ |
| ステップ応答 | $y(t) = K\left(1-\e^{-t/T}\right)$ |
| 極 | $s = -1/T$ |

::: exer
時定数 $T = 2\ \mathrm{s}$、ゲイン $K = 3$ の一次遅れ系に単位ステップ入力を加えた。出力が $2.7$ に達する時刻を求めよ。
:::

@space 150 box

---

@page id=howto

# 付録：この教材の操作

::: cols
::: col
**Apple Pencil**
- ペン・蛍光ペン・消しゴム
- レーザー：指し示す（すぐ消える）
- テキスト：タップして文字を入力
- 「操作」ツールでは教材を操作
- グラフの赤い点はドラッグできる

**指**
- 上下スクロール、スライダーの操作
- 素早い横スワイプでページ送り
:::
::: col
**ツールバー**
- ページを追加：白紙ページを挿入
- ↓：板書スペースを下に拡張
- ⋯：背景・PDF 出力・バックアップ
- ︿：ツールバーを最小化

**キーボード**
- ← → ページ送り、⌘Z 元に戻す
:::
:::
