---
title: PDF スライドの読み込み（デモ）
course: デモ
date: 2026-11-26
order: 2
blankBg: grid
---

<!--
  既存の PDF（PowerPoint・Keynote から書き出したもの）を講義に取り込む例。
  「@pdf ファイル pages=範囲 id=接頭辞」で PDF の各ページがそのまま講義のページになり、上に手書きできる。
  途中に Markdown のページ（数式・インタラクティブ教材）を挟める。
-->

@pdf slides.pdf pages=1-3 id=slide

---

@page id=exp-demo

# 例：$e^{-at}$ とそのラプラス変換

$a$ を変えると、時間応答 $f(t)$ と $F(s)$ の極 $s=-a$ がどう変わるかを見る。

@widget expDecay

---

@pdf slides.pdf pages=4- id=slide
