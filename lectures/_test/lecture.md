---
title: 自動テスト用
macros:
  \R: \mathbb{R}
---

<!-- tests/smoke.html が使うテスト用の講義。内容を変えるとテストが失敗するので編集しないこと -->

@page id=a

# Page A

本文 $x^2$ と $\R$。

$$
y = 1
$$

@space 300

---

@page id=b

# Page B

@widget probe

---

@page id=c layout=title

# Page C
