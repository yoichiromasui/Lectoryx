---
title: 講義タイトル
course: 科目名
lecture: 第N回
date: 2026-04-01
blankBg: grid
macros:
  \dd: \mathrm{d}
---

<!--
  新しい講義のひな形。このフォルダごとコピーして使う。
    lectures/<科目>/<NN-内容>/lecture.md  … 本文（このファイル）
    lectures/<科目>/<NN-内容>/widgets.js  … インタラクティブ部品（不要なら削除可）
    lectures/<科目>/<NN-内容>/media/      … 画像・動画（このフォルダの中身はすべて配信される）
  教材一覧への登録は不要（push すると自動で一覧に載る）。公開前に python tools/build.py で検証する。
  ・講義の ID = フォルダのパス（例 control/02-second-order）。授業で使った後はフォルダ名を変えない
    （変える場合はフロントマターに「id: 元のパス」を書く）。
  ・各ページに @page id=... を必ず書き、授業で使った後は変えない（書き込みの対応付けに使う）。
  ・まだ公開したくないときはフロントマターに「draft: true」。年度は date から自動（4 月始まり。year: で指定も可）。
  書式の詳細は CLAUDE.md を参照。
-->

@page id=title layout=title

# 講義タイトル

## 科目名 第N回

::: box 今日の目標
- 目標 1
- 目標 2
:::

---

@page id=intro

# 見出し

本文。インライン数式 $f(x) = x^2$、ディスプレイ数式は

$$
\int_0^1 f(x)\,\dd x = \frac{1}{3}
$$

::: def 用語
定義の本文。
:::

@space 200 box

---

@page id=demo

# インタラクティブな例

@widget example

---

@page id=board bg=grid

# 板書スペース
