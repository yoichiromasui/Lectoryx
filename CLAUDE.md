# CLAUDE.md — Lectoryx

**Lectoryx — Beyond static lectures.**（Lecture × Laboratory × Experience）
iPad + Apple Pencil で使う、大学・高専の数理系授業向けの講義アプリ（PWA）。
教材（Markdown + LaTeX + JS ウィジェット）の提示、手書きの書き込み、数値実験を 1 つの画面で行う。
運用：Mac/PC の Claude Code で教材を作る → GitHub に push → GitHub Actions が検証して配信
→ iPad のホーム画面アプリ（教材ライブラリ）でダウンロード → **教室では iPad だけ（ネットワーク不要）** で授業。

**リポジトリは 2 つ**（README 1）
- `yoichiromasui/Lectoryx`（**公開**）：このフォルダ。アプリ本体・ツール・テスト・公開デモ教材（`lectures/`）。push → GitHub Pages（`https://yoichiromasui.github.io/Lectoryx/`）。
- 教材用（**非公開**、例 `yoichiromasui/Lectoryx-courses`）：このフォルダの中の `courses/`（Lectoryx の `.gitignore` で除外した別の git リポジトリ）。push → `courses/.github/workflows/publish.yml` が Lectoryx の `tools/build.py` で検証して `dist` ブランチへ。iPad は GitHub API から Fine-grained トークン（Contents 読み取りのみ）で取得。
- **授業の教材は必ず `courses/` に作る**。`lectures/` に置くと公開される（`lectures/` は誰が見てもよいデモとテスト用だけ）。
- git 操作は対象のリポジトリで行う（教材は `cd courses` してから commit・push。アプリはこのフォルダで）。commit・push はユーザーに頼まれたときだけ。
このファイルは、Claude Code で **講義資料を作るとき** と **共通システムを改修するとき** の規則をまとめたもの。

---

## 0. 最優先の原則

1. **手書きの快適さ > 機能の多さ**。Apple Pencil の追従性・滑らかさを落とす変更はしない。
2. **授業中の操作は簡潔に**。確認ダイアログを増やさない（破壊的操作は Undo 可能にする）。
3. **ビルド不要・CDN 不要**。素の HTML/CSS/ES Modules。外部ライブラリは `vendor/` に同梱したものだけ使う。教材一覧の生成・検証は `tools/build.py` が自動で行う（教材を書く人は何もしなくてよい）。
4. **共通システム（`core/`）と講義コンテンツ（`lectures/`）を分離**。講義固有のコードを `core/` に入れない。新しい講義のためにアプリ本体を変更しない。
5. iPad Safari / ホーム画面アプリ（iPadOS 16.4 以降）で動くこと。デスクトップ Chrome/Edge/Safari は準備・確認用。
6. **授業中はネットワーク不要**。アプリ本体と、ダウンロードした教材だけで全機能（数式・グラフ・数値実験・手書き・PDF 出力）が動くこと。教材やアプリから外部 URL（CDN・Web フォント・外部 API）を参照しない。
7. **アプリ・教材の更新はユーザーが明示的に押したときだけ**。授業中に勝手に切り替わる仕組みを作らない。書き込みは更新・削除で消さない。

---

## 1. 絶対に守る設計上の制約（書き込みの位置ずれ防止）

手書きは「論理ページ座標」（幅 `PAGE_WIDTH = 1024` px）で保存し、教材も同じ座標系でレイアウトして
ページ全体を CSS `transform: scale()` で拡大縮小している。したがって：

- **教材のレイアウトを画面サイズに依存させない。** `vw` / `vh` / `%` 高さ / メディアクエリを教材（`content.css`・講義内 HTML）で使わない。中央寄せは固定の論理高さ内で行う（`.lw-layout-title { min-height: 630px }`）。
- **教材のレイアウトを後から動的に変えない。** ウィジェットの出力でページの高さや要素位置が変わると、下にある書き込みとずれる。出力欄は `width`/`height` を固定し、折り返しが起きない長さにする。
- **ページ内にスクロール領域を作らない**（`overflow: auto` の表・コード等）。内部スクロールすると書き込みと教材がずれる。
- **画像・動画にはサイズ（width と height）を指定する**（読み込み前後でレイアウトが変わらないように）。
- **授業で書き込んだ後の教材を大きく変えない。** 誤字修正程度は可。ページの挿入・削除は可（ページ ID で対応付けている）が、ページ内の要素の位置が変わる修正をすると、そのページの書き込みとずれる。
- **ページ ID を変えない。** 書き込みはページ ID に紐づく。`@page id=...` を必ず明示する（未指定だと見出し文字列から自動生成され、見出しを直すと書き込みが外れる）。
- `@pdf` のページ ID は「接頭辞-PDF のページ番号」。使用済みの PDF の途中にページを挿入して差し替えると、以降の書き込みがずれる（追加は末尾か別ファイルで）。
- `config.js` の `PAGE_WIDTH`、`ink/stroke.js` の `pressureFactor()`、ストロークの保存形式を変更しない。変更が必要なら `INK_FORMAT_VERSION` を上げ、移行処理を書く。
- 教材の基本フォントサイズ（24px）や余白（`content.css`）を変えると既存講義の書き込みが全部ずれる。変える場合は講義ごとのクラス（`@page class=...`）で上書きする。
- **講義 ID を変えない。** 書き込みのキーは「講義 ID ＋ページ ID」。講義 ID はフロントマターの `id:`、なければ教材ルートからのフォルダパス（`control/01-first-order-lag`）。使用済みの講義のフォルダを移動・改名するときは、フロントマターに `id: 元のパス` を書く。
- ウィジェットの操作部品（slider/number/checkbox/select）とドラッグ点の値は「ページ内のウィジェット番号:名前」と **作成順** で保存・復元される。使用済みの widgets.js で部品の順序を入れ替えない（追加は末尾に）。
- 互換性を保つもの（変えるなら移行処理と版の管理を書く）：IndexedDB `lecture-web` のストア名とキー、`PageRecord` の形式、Cache Storage の名前（`lw-app-<版>`, `lw-lec-<版>`, `lw-meta`）、端末内の教材 URL `offline/<版>/<パス>`、`sw.js` とページのメッセージ（`status`, `skip-waiting`, `use-latest`）、`catalog.json` の形式。

---

## 2. ディレクトリ構成

```
index.html                 教材ライブラリ（科目・年度別の一覧、ダウンロード、更新、バックアップ、設定）
lecture.html               講義ビューア（lecture.html?l=<講義パス>[&v=<版>]#<ページ番号>）
sw.js                      Service Worker（アプリ本体と教材のオフライン配信。6.5）
manifest.webmanifest       ホーム画面に追加したときの設定
assets/                    アイコン
.github/workflows/deploy.yml  push → 検証 → GitHub Pages（アプリ＋公開デモ教材）
core/                      共通システム（講義に依存しない）
  app.js                   講義画面の起動・結線・キーボード・スワイプ・書き出し/読み込み
  pwa.js                   Service Worker の登録、アプリの更新（ユーザー操作でのみ切り替え）
  diag.js                  動作の記録（固まった時間・無視したタッチ・遅い処理・エラー。⋯ →「動作の記録」でコピー）
  config.js                定数（論理ページ幅、ツール既定値、保存設定）
  util.js                  DOM 生成 h()、Emitter、rect 等
  settings.js              端末ローカル設定（localStorage）
  store.js                 IndexedDB 永続化（書き込み・ライブラリ・設定）、容量の確認
  book.js                  ページ列（教材 + 白紙）と書き込み状態、保存、書き出し/読み込み
  view.js                  PageView：表示・拡大縮小・ページ切替・レイヤー結線
  content/markdown.js      lecture.md の解析（フロントマター・ページ分割・ディレクティブ・数式）
  content/lecture.js       講義の読み込み（lecture.md / widgets.js / @pdf の展開）
  content/pdf.js           PDF 教材（PDF.js の遅延読み込み・ページ描画・見出し抽出）
  content/source.js        教材の配信元（教材ルート）と端末内の教材 URL
  library/main.js          教材ライブラリの画面（index.html）
  library/download.js      教材一覧の取得、ダウンロード・検証・版の管理・削除（6.6）
  library/backup.js        バックアップ（教材＋書き込み .zip／書き込み .json）と復元
  library/zip.js           ZIP の作成・読み込み（外部ライブラリなし）
  export/print.js          PDF 出力（A4 横の印刷用レイアウトを作って window.print()）
  ink/stroke.js            ストロークのデータ構造と描画（中点二次ベジエ、筆圧→線幅）
  ink/layer.js             タイル分割キャンバス（InkLayer）と入力中レイヤー（LiveLayer）
  ink/input.js             ペン/指/マウスの振り分け、パームリジェクション
  ink/controller.js        ペン・蛍光ペン・消しゴム・レーザー・テキストの動作
  ink/eraser.js            消しゴムの幾何計算（ストローク単位・部分消去）
  ink/history.js           Undo/Redo（ページ単位）
  ink/laser.js             レーザーポインタ（保存しない一時表示）
  ink/text.js              テキストの書き込み（表示層・入力欄・移動。$...$ は KaTeX）
  ink/svg.js               ストローク → SVG（PDF 出力用。drawStroke と同じ幾何）
  widgets/widget.js        ウィジェット API（w.slider, w.plot, w.render ...）
  widgets/controls.js      スライダー・数値入力・チェック・選択・ボタン・アニメーション
  widgets/plot.js          軽量 2D プロット（Canvas）
  widgets/numeric.js       数値計算の道具（w.math）
  widgets/index.js         教材中のウィジェット要素の初期化
  ui/toolbar.js            上部ツールバー（授業モード：設定 compact で隠し、右上の小さなボタンで一時表示）
  ui/pagebuttons.js        授業モードのページ送りボタン（左下。短いタップのみ・手のひら／ペン直後／なぞりは無視）
  ui/panels.js             ページ一覧・メニュー・トースト
  ui/icons.js              アイコン
  ui/files.js              ファイルの保存（iPad は共有シート）・選択
  styles/app.css           講義画面の UI のスタイル
  styles/content.css       教材本文・ウィジェットのスタイル
  styles/library.css       ライブラリ画面のスタイル
vendor/                    KaTeX 0.19.1（min.js/css/woff2）, marked 18.1.3（ESM）,
                           PDF.js 6.5.438 legacy build（pdf.min.mjs, worker, cmaps, standard_fonts, wasm, iccs）
lectures/                  公開デモ・テスト用の教材ルート（GitHub Pages で公開される。catalog.json は生成物）
  site.json                ライブラリのタイトル・副題・科目の並び順（"demo": true でデモの案内を表示）
  _template/               新しい講義のひな形
  _test/, _test_pdf/       自動テスト用（編集しない。_ で始まるフォルダは一覧・公開の対象外）
  demo/first-order-lag/    デモ（数式・ウィジェット・アニメーション。tests/offline.html が使う）
  demo/pdf-slides/         PDF 取り込みのデモ（slides.pdf + Markdown ページ）
courses/                   授業の教材ルート（別の非公開リポジトリ。Lectoryx には含めない）
  site.json, README.md, CLAUDE.md, .github/workflows/publish.yml
  <科目>/_lib/*.js         科目で共通の計算（widgets.js から相対 import。依存として自動で配信される）
  <科目>/<NN-内容>/
    lecture.md             本文
    widgets.js             インタラクティブ部品（任意）
    media/                 画像・動画（中身はすべて配信される）
tests/smoke.html           回帰テスト（合成入力で手書き・保存などを検証）
tests/offline.html         オフライン動作のテスト（ダウンロード → ネットワークなしで全機能・更新・バックアップ）
tests/e2e_prod.py          本番ビルドの総合テスト（サブディレクトリ配信・サーバ停止・アプリ更新・非公開リポジトリ構成）
tests/screens.html         見た目確認用（サイズ・UI 状態を指定して開く）
tools/build.py             教材の検証・教材一覧（catalog.json）の生成・公開フォルダ（_site）／教材フォルダ（_content）の作成
tools/push_dir.sh          フォルダをブランチに 1 コミットで push（CI 用。改行変換なし）
tools/serve.py             開発用サーバ（catalog.json と sw.js をその場で生成。courses/ を lectures/ と合わせて /lectures/ に見せる。no-cache）
```

---

## 3. 講義資料の作り方（手順）

1. `lectures/_template/` を **`courses/<科目>/<NN-内容>/`** にコピー（例: `courses/control/02-second-order/`）。フォルダ名は英数字・`-`・`_`（`courses/` からのパスが講義 ID になる）。
2. `lecture.md` を書く（下記の書式）。フロントマターの `title`・`course`・`lecture`・`date` がライブラリの表示・分類に使われる。インタラクティブ部品が要るなら `widgets.js` に関数を書く。
3. **教材一覧への登録は不要**（`lecture.md` があるフォルダは自動で一覧に載る。公開したくないものは `draft: true`）。
4. `python tools/build.py --check --content-dir courses` で検証する（ページ ID の欠落・重複、存在しないファイル・ウィジェット、外部 URL の import などをエラーにする。エラーがあると配信されない）。デモ教材（`lectures/`）は `python tools/build.py --check`。
5. `python tools/serve.py` で起動し、`http://localhost:8000/lecture.html?l=control/02-second-order` で確認。
   - 確認は **横 1180×820（iPad Air 横向き）相当** で、各ページが 1 画面に収まるかを見る（収まらなくてもスクロールできるが、授業ではなるべく 1 画面）。
   - 1 画面の目安：論理サイズ 1024 × 約 670px（ツールバー除く）。本文 24px・行間 1.62 で 12〜14 行程度。
   - ヘッドレス確認例：`chrome --headless=new --window-size=1180,820 --screenshot=out.png "http://localhost:8000/lecture.html?l=...#3"`
6. ユーザーに頼まれたら `courses/` で commit・push（push すると GitHub Actions が検証して `dist` に置き、iPad のライブラリの「更新を確認」で取得できる）。
7. 共通システムを触った場合は 6.7 のテストを通す。

### 使用済みの教材を直すとき
- 誤字・数式の修正は可（版が上がり、iPad で「更新」すると反映）。書き込みのあるページの内容が変わった場合、アプリは旧版を残して「旧版で開く」を可能にする（6.6）が、なるべくレイアウトが変わらない直し方にする。
- ページの追加・並べ替えは可（書き込みはページ ID で対応）。ページ ID・講義 ID は変えない。大きく作り直すときは別の講義（別フォルダ）にする。

### 内容面の方針（数理系授業）
- 1 ページ 1 トピック。文章は短く、板書で補う前提で **書き込み用の余白**（`@space`）を残す。
- 導出の途中は教材に全部書かず、要所の式だけ置いて手書きで埋められるようにする。
- インタラクティブ教材は「パラメータ → 結果の変化」が一目で分かる最小構成にする（スライダー 1〜3 個 + グラフ 1〜2 枚）。
- 句読点は「、。」を使う（エディタの textlint 既定に合わせる）。数式中の記号は KaTeX 標準。

---

## 4. 教材の書式（lecture.md）

### 4.1 フロントマター
ファイル先頭の `---` で囲む（YAML の簡易サブセット：`key: value` と、1 段のネスト）。
```yaml
---
title: 一次遅れ系の応答       # 講義名（ライブラリ・ページ一覧・タブに表示。必須）
course: 制御工学               # 科目（ライブラリの分類）
lecture: 第5回
date: 2026-12-01              # 授業日（YYYY-MM-DD）。年度はここから自動（4 月始まり）
year: 2026                    # 年度を明示する場合（任意）
order: 5                      # 科目内の並び順（任意。省略時は date 順）
id: control/01-first-order-lag   # 講義 ID（任意。省略時はフォルダパス。フォルダを移したときだけ書く）
draft: true                   # 公開しない（任意）
assets:                       # 本文から参照していないが配信したいファイル（任意。講義フォルダからの glob）
  - data/*.csv
blankBg: grid                 # ＋で追加する白紙ページの背景（none|grid|lines|dots）
macros:                       # KaTeX マクロ（講義内で共通）
  \dd: \mathrm{d}
  \Lap: \mathcal{L}
widgets: widgets.js           # 省略時 widgets.js（false で読み込まない）
---
```

### 4.2 ページ
- **行全体が `---` の行でページを区切る**（コードブロック・`$$` 内は除く）。水平線が欲しいときは `***`。
- 各ページの先頭に **`@page id=<英数字の ID>`** を書く（必須の慣例）。属性：
  - `id`：書き込みの対応付けに使う。講義内で一意・不変。
  - `layout=title` / `layout=center`：中央寄せ（固定高さ 630px 内）。
  - `bg=grid|lines|dots|none`：ページ背景（方眼・罫線・ドット）。
  - `title="..."`：ページ一覧での名前（省略時は最初の見出し）。
  - `class=...`：教材要素に付けるクラス（講義固有の調整用）。
- 見出しは ATX 形式（`#`）のみ。Setext（下線）形式は `---` と衝突するので使わない。

### 4.3 Markdown の方言
- GFM（表・取り消し線など）。**改行はそのまま改行**（`breaks: true`）。段落は空行で区切る。
- `*強調*` は **赤字の太字**（日本語の斜体は見にくいため）。`**太字**` は太字。
- HTML を直接書ける（`<div>`, `<span style>`, `<br>` 等）。HTML コメント `<!-- -->` は表示されない。
- 相対パス（`media/fig.png`）は講義フォルダ基準に解決される。

### 4.4 数式（KaTeX）
- インライン `$...$` または `\(...\)`、ディスプレイ `$$...$$` または `\[...\]`。
- ディスプレイ数式は前後を改行で独立させる。`aligned`, `cases`, `pmatrix` 等は KaTeX 対応のもの。
- 文中の `$` 記号は `\$`。インライン数式は `$` の直後・直前に空白を置かない（`$ x $` は数式にならない）。
- 表のセル内の `|` を含む数式もそのまま書ける（数式を先に退避してから Markdown を処理するため）。
- 本文 24px に対し KaTeX は 1.08em。`\dfrac` は行間が広がるので本文中では控えめに。

### 4.5 コンテナ（`:::` で開き、`:::` で閉じる。入れ子可）
| 書式 | 表示 |
|---|---|
| `::: def タイトル` | 囲み「定義」（青） |
| `::: thm` / `prop` / `lemma` / `cor` | 定理・性質・補題・系（赤） |
| `::: ex` | 例（緑） |
| `::: exer` / `q` / `ans` | 演習・問（紫）／解答（灰） |
| `::: note` | 注意（橙） |
| `::: point` | ポイント（青緑） |
| `::: box タイトル` | 汎用の囲み（灰。タイトル省略可） |
| `::: cols` + 子の `::: col` | 段組み（等幅）。`::: cols 3:2` で比率指定 |
| `::: center` / `right` / `small` / `large` / `muted` / `red` / `blue` / `math-left` | 体裁（`lw-<名前>` クラスの div。`math-left` はディスプレイ数式を左寄せ） |
| `::: 任意名` | `<div class="lw-任意名">`（講義固有の CSS は `<style>` を HTML で書くか class で） |

タイトルには `$...$` も書ける（`::: point 時定数 $T$ の意味`）。

### 4.6 1 行ディレクティブ（行頭 `@`、インデント不可）
| 書式 | 説明 |
|---|---|
| `@page id=... layout=... bg=...` | ページ属性（4.2） |
| `@space 200 [box\|grid\|lines\|dots]` | 板書用の空白（高さ px）。`box` は破線枠 |
| `@widget 名前 key=value ...` | widgets.js の関数 `名前(w, opts)` を配置。opts は数値・文字列（`"..."`）・真偽 |
| `@image path width=360 height=240 caption="..."` | 画像（width/height を指定） |
| `@video path width=640 height=360 [loop] [muted] [autoplay] poster=...` | 動画（playsinline 付き） |
| `@iframe url width=... height=...` | 埋め込み（iframe 上ではペンで書けない） |
| `@pdf file.pdf pages=1-8 id=s` | **PDF の各ページを講義のページとして展開**（4.7）。この行だけのページにする |

### 4.7 既存の PDF 資料（`@pdf`）
- `---` で区切ったページに `@pdf slides.pdf pages=範囲 id=接頭辞` だけを書く。PDF の各ページが 1 ページずつ講義のページになる（前後に Markdown のページを自由に挟める）。
- `pages`：`1-8`、`9-`（最後まで）、`1,3,5-7`。省略で全ページ。`id`：ページ ID の接頭辞（→ `s-1`, `s-2`…）。省略時はファイル名。`@page id=` を同じページに書いても接頭辞になる。
- 表示：幅 1024 に合わせて拡大縮小（16:9 なら 1024×576）。下の余白は板書スペース。ページ一覧の見出しは PDF の文字から自動抽出。
- PPTX は直接読めない。PowerPoint/Keynote で PDF に書き出してから置く（Keynote は「各ビルド段階を別ページ」で段階表示も再現できる）。
- PDF.js は `@pdf` を使う講義でだけ読み込まれる（他の講義の起動は重くならない）。

### 4.8 配信されるファイル（依存リソース）
`tools/build.py` が講義ごとに次を集め、`catalog.json` の `files`（パス・サイズ・SHA-256）に載せる。iPad はこれをすべて取得・照合してから「オフライン可」にする。
- `lecture.md`、`widgets.js` と、そこから **相対 import** したファイル（`../_lib/tf.js` など。再帰的にたどる）。`new URL('data.json', import.meta.url)` も依存になる。
- 本文から参照したファイル：`@image` `@video`（`poster=` も）`@pdf`、Markdown の `![](...)` `[](...)`、HTML の `src=` `href=` `poster=`。
- `media/` フォルダの中身すべてと、フロントマター `assets:` に書いたファイル。
- それ以外（参照していない下書き・元の PowerPoint など）は **公開されない**（検証で「配信されないファイル」として表示）。隠しファイル・認証情報らしいファイルは配信しない。
- 外部 URL（`https://...`）の import・画像はオフラインで動かないので使わない（import はエラー）。`@iframe` の外部ページはオンライン時のみ。
- 1 ファイル 95MB まで（GitHub の制限）。動画は 30MB 程度までに圧縮する（ダウンロード時間・iPad の容量）。

---

## 5. ウィジェット API（widgets.js）

`lecture.md` の `@widget 名前` ごとに、同名の **export された関数** が 1 回呼ばれる。
```js
export function stepResponse(w, opts) {
  const T = w.slider({ label: '時定数 $T$', min: 0.2, max: 5, step: 0.1, value: 1, unit: 's' });
  const p = w.plot({ x: [0, 10], y: [0, 1.2], xlabel: '$t$ [s]', ylabel: '$y(t)$', height: 330 });
  w.render(() => {                       // 値が変わるたびに次フレームで実行
    p.fn((t) => 1 - Math.exp(-t / T.value), { color: 'blue', label: '$y(t)$' });
  });
}
```
- 部品は **関数の本体で 1 回だけ作る**。`render()` の中では「描くだけ」（部品を作らない・DOM を増やさない）。
- 値の読み出しは `ctrl.value`（書き込みも可）。`ctrl.onChange(fn)` で個別の通知も受けられる。
- 操作部（slider 等）は `.lw-controls`（`data-ink="off"`：ペンでも操作できる）、表示部（plot 等）は `.lw-display` に作成順で並ぶ。
- ラベル文字列はすべて `$...$` 数式と `**太字**` が使える。JS 文字列内のバックスラッシュは `\\` と書く（`'$\\tau$'`）。
- 例外は widget 内に赤字で表示される（ページ全体は止まらない）。

### 5.1 操作部品
| 関数 | 主なオプション | 戻り値 |
|---|---|---|
| `w.slider(o)` | `label, min, max, step, value, unit, format(v)→str, width` | `.value`（数値）。値表示をダブルタップで初期値に戻る |
| `w.number(o)` | `label, value, step, min, max, unit` | −/＋ 付き数値入力 |
| `w.checkbox(o)` | `label, value` | `.value`（真偽） |
| `w.select(o)` | `label, options:[値…] or [{label,value}…] or {表示:値}, value` | セグメントボタン |
| `w.button(label, fn)` | | クリックで `fn()` → 再描画 |
| `w.animation(o)` | `duration`(s), `loop`, `speed`, `autoplay`, `label`, `unit`, `showTime` | `.t`（経過秒）, `.playing`, `play()`, `pause()`, `reset()`, `onFrame(fn)`。▶/⏸/⟲ ボタン付き。ページを離れると停止。3 分間だれも操作しなければ自動で一時停止（電池の節約） |
| `w.br()` | | 操作部の改行 |

### 5.2 表示部品
- `w.plot(o)` → **Plot**（5.3）
- `w.canvas({width, height})` → `{ ctx, width, height }`。`ctx` は論理 px 座標で、描画前に自動消去。
- `w.output({ width, height, display, in: 'controls' })` → `.tex(src)`（KaTeX）, `.md(text)`（`$..$` 混じり文）, `.text(s)`, `.html(s)`。同じ内容なら再描画しない。**幅を固定する**（レイアウト不変のため）。
- `w.setLayout('top'|'bottom'|'side')`：操作部を上／下／右に（`@widget name layout=side` でも可）。side では plot の `width` を指定。
- `w.onShow(fn)` / `w.onHide(fn)`：ページ表示・非表示時。`w.invalidate()`：再描画の予約。
- `w.opts`：`@widget` 行の key=value。`w.math`：数値計算（5.4）。`w.color(name)`：色名 → CSS 色。

### 5.3 Plot
```js
const p = w.plot({ width, height, x:[xmin,xmax], y:[ymin,ymax], xlabel, ylabel, title,
                   grid:true, equal:false, axes:'box'|'cross', xticks, yticks,
                   xtickFormat:(v)=>str, legend:'ne'|'nw'|'se'|'sw'|false });
```
- `width` 省略時は表示欄の幅（最大 880）、`height` 省略時は幅の半分。`equal:true` で縦横の目盛りを等しく（複素平面）、`axes:'cross'` で原点を通る矢印付き軸。
- 描画（`render` 内で毎回呼ぶ。データ座標。`this` を返すので連鎖可）：
  - `p.fn(f, o)` y=f(x)（`o.domain:[a,b]`, `o.samples`）／`p.param(fx, fy, {domain})`
  - `p.line(xs, ys, o)`／`p.path([[x,y],…], o)`／`p.area(f or pts, {base, alpha})`
  - `p.point(x, y, {radius, hollow, label, anchor})`／`p.points(pts, o)`
  - `p.hline(y, o)`／`p.vline(x, o)`／`p.segment(x0,y0,x1,y1,o)`／`p.arrow(x0,y0,x1,y1,{head})`
  - `p.circle(cx, cy, r, {fill, fillAlpha})`／`p.rect(x0,y0,x1,y1,o)`／`p.polygon(pts, o)`
  - `p.label(x, y, '数式 $...$', {anchor:'ne'|'n'|'e'|…|'c', color, size, offset:[dx,dy]})`（KaTeX、HTML 重ね）
  - `p.text(x, y, str, {align, baseline, size, color})`（キャンバス文字。高速）
  - 共通スタイル `o`：`color`（`blue|red|green|orange|purple|teal|gray|black` または CSS 色）, `width`, `dash`（true or `[8,6]`）, `alpha`, `label`（凡例）
- ドラッグ点（**render の外で 1 回作る**）：
  ```js
  const z = p.handle({ x: -1, y: 0, color: 'red', label: '$p$', constrain: (x, y) => [Math.min(x, 0), 0], snap: 0.1 });
  // render 内で z.x, z.y（複素数なら z.z = {re, im}）を参照
  ```
  指・マウスでドラッグ。ペンも点の真上から始めればドラッグ（それ以外の場所ではペンは手書き）。
- `p.setRange({x, y})`、座標変換 `p.X(x)`, `p.Y(y)`, `p.invX(px)`, `p.invY(py)`、生の `p.ctx` も使える。

### 5.4 w.math（`core/widgets/numeric.js`）
`linspace(a,b,n)`, `range(a,b,step)`, `rk4(f, y0, t0, t1, n)`（スカラー/配列, `{t, y}` を返す）,
複素数 `cx(re,im)`, `cadd`, `csub`, `cmul`, `cdiv`, `cabs`, `carg`, `cconj`, `cexp`, `cpolar(r,θ)`, `roots2(a,b,c)`,
表示 `fmt(x, 桁)`（負号 −）, `cfmt(z, 桁)`（a ± jb）, `clamp`, `lerp`。
講義・科目で共通の計算（伝達関数の周波数応答など）は `courses/<科目>/_lib/*.js` に置き、widgets.js から相対 import する（`core/` には置かない）。

### 5.5 ウィジェットの規則
- サイズは固定（`width`/`height` を明示）。出力欄も固定幅。値の変化で高さが変わらないこと。
- 1 ページの重い計算は `render` 内で 10ms 以下に。ODE などはステップ数を抑えるか、パラメータ変更時だけ計算してキャッシュ。
- グラフの点のドラッグ以外で、ページ上の指ジェスチャを奪わない（`touch-action` を勝手に変えない）。
- グローバル変数・`window` を汚さない。タイマーは `w.animation` を使う（ページ離脱で止まる）。
- 外部 URL を使わない（CDN の import・外部 API・Web フォント）。共通の計算は `<教材ルート>/<科目>/_lib/` に置いて相対 import。データファイルは `media/` か `assets:` に入れて `new URL('media/x.csv', import.meta.url)` などで読む。
- 操作部品・ドラッグ点の値はページごとに自動保存・復元される（次に開いたときも同じ状態。メニュー「このページの数値実験を初期状態に戻す」でリセット）。部品は毎回同じ順序で作る。

---

## 6. 共通システムの仕組み（改修する場合）

### 6.1 座標と表示
- `#stage`（縦スクロール） > `.lw-sizer`（表示サイズ） > `.lw-page`（論理 1024 × H, `transform: scale(s)`）。
- `s = min(画面幅/1024, 画面高/(1024×0.62))`。iPad は横幅基準。ページ高さ H = max(教材の高さ, 1 画面) + 拡張分、かつ書き込みの最下端を含む。
- 教材・テキスト層・3 枚の描画層（蛍光 `mix-blend-mode:multiply` → ペン → 入力中）を同じ `.lw-page` に重ねる。

### 6.2 手書き
- 入力：`ink/input.js`。ペンは `touchstart`（`touchType==='stylus'`）を `preventDefault` してスクロール等を抑止し、`pointerdown` をキャプチャ段階で `stopPropagation`。指はネイティブのスクロール・教材操作に任せる。
- パームリジェクション：ペン接触中とペンを離して `PALM_GUARD_MS`（450ms）は指を無効化。ペンを使ってから `PALM_RECENT_MS`（1.5 秒）以内は接触半径 `PALM_RADIUS`（45）超のタッチも無効。ツールバーは `TOOLBAR_PALM_GUARD_MS`（250ms）。長くすると「指で操作しても反応しない＝固まった」ように見えるので注意（実機で「固まる」と言われた。2026-11）。無視したタッチは `diag` に記録。
- ペン先のダブルタップ（`DOUBLE_TAP`：1 回 250ms 以内・ずれ 4px 以内、間隔 350ms 以内・距離 9px 以内）でペン/蛍光ペン⇔消しゴム（`InkController._tapEnd`）。2 回のタップで付いた点・消えた線は `view.revertOps` で取り消し（やり直し履歴も元に戻す）。設定 `penDoubleTap`。Apple Pencil 本体のダブルタップ（UIPencilInteraction）は Web には届かないので使えない。
- ページ送り：`view.turn(±1)`（`next/prev`）。設定 `pageTransition` が `slide` なら、今のページが横に抜けて次のページが反対側から滑り込む（150ms＋200ms。動きの最中は `view.turning` で書き込みを受け付けない。prefers-reduced-motion では即時）。スワイプはスライド時、指に合わせて `.lw-sizer` を `translateX` で動かし、十分に引っ張る（画面幅の 18% か 80px）か素早く払うと送る。
- ページ送りのスワイプはグラフの上でも有効（`[data-ink=off]` の操作パネル・`lwWantsPointer` が真の点・動画等は除く）。ドラッグ点のあるグラフは `touch-action:none` にせず、点の上で始まった `touchstart` だけ `preventDefault`（グラフの上でもスクロールできるように）。
- 描画：確定セグメントはタイル（高さ 512 の論理 px）へ追記、末尾の暫定セグメントだけ `LiveLayer` に描く（遅延ゼロで滑らか）。タイルは表示範囲 ± 0.5 画面だけ確保（長いページでもメモリ一定）。
- `getCoalescedEvents()` があれば使う。点は 0.35 論理px 未満の間隔を間引き、座標は 0.1、筆圧は 0.01 に丸めて保存。
- Undo/Redo はページ単位。操作は「削除したストローク（元位置）と追加したストローク（新位置）」の差分で、全消去・部分消去・拡張も同じ仕組み。

### 6.2b レーザーポインタ（`ink/laser.js`）
- ツール `laser`。入力経路はペンと同じ（スクロール抑止・パームリジェクションも同じ）だが、ストローク配列・履歴・保存・PDF には一切入らない。
- 軌跡モード：ペンを離して `LASER_HOLD_MS`（0.6 秒）後に `LASER_FADE_MS` で全体がフェード。消え切る前（フェード中も）に描き始めれば元の濃さに戻り、まとめて残る。点モード：ペン先の光点、離すと `LASER_DOT_FADE_MS` で消える。時間は `config.js`。
- 表示範囲だけを覆うキャンバスに rAF で描画（表示中のみループ）。ページ切替で即消去。

### 6.2c PDF 出力（`export/print.js`）
- 全ページの教材 DOM を複製して A4 横（297×210mm）のシートに並べ、`body.lw-printing` を付けて `window.print()`。印刷 CSS は `app.css` 末尾（`@page` のサイズと `SHEET_MM` を一致させること）。
- 幅をシートに合わせ（倍率一定）、長いページは複数シートに分割（ページ高さ = 教材の高さと書き込みの最下端の大きい方。拡張しただけで空の部分は出さない）。
- テキストは同じ DOM（`renderTextLayer`）を教材と手書きの間に重ねる。書き込みは `ink/svg.js` でベクター化（蛍光ペンは不透明度 0.5 のグループ。印刷では合成モードが効かない環境があるため）。キャンバス（グラフ・PDF 教材）は画像化、動画・iframe は枠に置き換え。未表示のページのウィジェットはこのとき初期化する。
- `lecture.html?l=…&print=1` で開くと直ちに印刷画面、`&print=view` は印刷用 DOM を作るだけ（ヘッドレス Chrome の print-to-pdf で確認する用）。

### 6.2d PDF 教材（`content/pdf.js`）
- `@pdf` のページは `.lw-content-pdf` 内のキャンバスに PDF.js で描画（解像度は手書きと同じ `scale × dpr`）。別キャンバスに描いてから転写するので再描画中も白くならない。
- 表示中のページをすぐ描画し、前後のページは 450ms 後（書いている最中は書き終わってから）に描画（送った直後に重くならないように）。それ以外は解放してメモリを抑える（`PageView.updatePdf`）。
- PDF 出力時は 2 倍解像度で別途描画して JPEG 化する。

### 6.2e テキスト（`ink/text.js`）
- ツール `text`。入力経路はペンと同じ（`InkController` → `TextLayer.begin/move/end`）。何もない所をタップで新規、既存の文字をタップで編集、ドラッグで移動。入力欄の外をタップ・Esc・⌘Enter・ツール切替・ページ移動・Undo で確定。空にすると削除。
- 入力欄（`textarea`、`data-ink="off"`）はペンを離したイベントの中で `focus()` する（iPad でキーボードを出すため。ペンのタップでスクリブルも使える）。
- 表示は `.lw-text-layer`（教材の上・蛍光ペンの下。`pointer-events:none`）の絶対配置 div。`white-space: pre-wrap`、ページ右端で折り返し。ページ高さにはテキストの最下端も含める。
- 消しゴムではテキストは消えない（全消去では消える）。履歴は `op.texts = [{i, a, b}]`（変更前・変更後のテキスト）。

### 6.3 データ
```
Stroke      = { id, t:'pen'|'hl', c:'#rrggbb', w:基準線幅, p:[x,y,pressure, …] }   // 論理座標
Text        = { id, x, y, v:文字列($..$ は数式), c:'#rrggbb', s:文字サイズ }        // x, y は左上の論理座標
PageRecord  = { strokes, texts, widgets:{"番号:名前":[値…]}, extra:拡張した高さ, bg:背景|null, updated }  // texts・widgets は後から追加
LectureMeta = { added:[{id:'blank-…', after:直前ページID, bg}], lastPage, lastScroll, updated }
LibraryRecord = { id, path, current:版, source, versions:{ 版: { entry, downloadedAt, bytes, sigs, changed, prev, kept } } }
```
- IndexedDB `lecture-web`（版 2）：`pages`（キー `講義ID\u0001ページID`）、`lectures`（キー 講義ID）、`library`（キー 講義ID）、`kv`（教材一覧の控え `catalog`、最近使った `recent`、既読 `seen`）。変更から 0.8 秒後と画面非表示時に保存。
- 教材本体は Cache Storage（`lw-lec-<版>`）、アプリ本体は `lw-app-<版>`。書き込みと教材は別に管理し、教材の更新・削除で書き込みは消えない。
- 白紙ページは「どのページの後に作ったか」を作成順に記録し、読み込み時に差し込む。
- 講義ごとの書き出し JSON：`{ format:'lecture-web-ink', version:1, lecture, exportedAt, meta:{added}, pages:{ID: PageRecord} }`。現在の教材にないページ ID の記録も含める（消さない）。
- 全体バックアップ（ライブラリの ⋯）：ZIP（無圧縮）に `backup.json`（`{ format:'lecture-web-backup', version:1, createdAt, source（トークンなし）, library, ink:{講義ID:{meta,pages}} }`）と `materials/<版>/<パス>`。書き込みだけのときは backup.json のみ（.json）。復元は含まれる講義の書き込みを置き換え、教材の版を追加する。

### 6.5 PWA・オフライン（`sw.js`, `core/pwa.js`）
- `sw.js` の `BUILD`（版・アプリのファイル一覧と各 SHA-256 先頭）は `tools/build.py`（公開時、`dev:false`）と `tools/serve.py`（開発時、`dev:true`）が埋め込む。アプリのファイル一覧は `index.html, lecture.html, manifest.webmanifest, assets/, core/, vendor/` を自動で走査（ファイルを足しても登録作業は不要）。
- インストール時にアプリ本体を `lw-app-<版>` に保存（前の版と同じハッシュのファイルは再利用）。**使用する版は `lw-meta` のポインタで決まり、ユーザーが「アプリを更新」を押す（`use-latest`）まで切り替えない**。新しい Service Worker が自動で有効になっても（アプリを完全に閉じたとき）、古い版のファイルを返し続ける。初回と開発時（`dev`）だけ即座に使う。開発時はネットワーク優先。
- 教材は `offline/<版>/<教材ルートからのパス>` を `lw-lec-<版>` から返す（`Range` 要求には 206 で応答。HEAD にも応答）。版ごとに URL が違うので旧版と新版を並べて保持できる。
- Service Worker は HTTPS か localhost でだけ動く。LAN の `http://192.168…` ではオンライン専用（ライブラリにその旨を表示）。
- PDF.js は PDF 本体・cmaps・標準フォントをメインスレッドで取得する（`useWorkerFetch:false`。ワーカーの fetch が Service Worker を通らない環境があるため）。
- iPadOS の注意：Safari のタブとホーム画面アプリは保存領域が別。ストレージは容量不足時などに消されることがある（ライブラリで容量表示・永続化の依頼・バックアップを促す）。`navigator.share` はタップの直後にしか使えない（バックアップは作成後に「保存する」を押してもらう）。

### 6.6 教材ライブラリ・ダウンロード・版（`core/library/`）
- 配信元（`core/content/source.js`）：URL（既定 `<アプリ>/lectures/`。localStorage `lw.contentRoot`）または GitHub（localStorage `lw.contentSource` = `{type:'github', repo, branch:'dist', token}`）。GitHub では `GET /repos/{repo}/git/ref/heads/{branch}` で最新コミットを取り、`GET /repos/{repo}/contents/{path}?ref=<そのコミット>`（`Accept: application/vnd.github.raw+json`、`Authorization: Bearer`）で catalog.json と各ファイルを同じ時点から取得する（途中で push されても混ざらない）。GitHub は `Content-Type` を独自形式で返すので、保存時に拡張子から付け直す（JS モジュールのため）。
- **トークンの扱い**：端末の localStorage だけに保存。バックアップ・ライブラリの記録・catalog の控えには入れない（`publicSource()`）。リポジトリにも公開フォルダにも書かない（`app-config.json` は `{contentType:'github'}` だけ）。
- GitHub の配信元では、未ダウンロードの教材は開けない（タップするとダウンロードしてから開く。講義画面に直接来た場合は案内を表示）。
- `catalog.json` を取得し、kv に控える（オフラインでも一覧を表示）。既定の配信元はアプリと一緒に公開したデモ（`demo: true` なら「自分の教材は配信元を設定」と案内）。`tools/build.py --app-only` で教材なしのアプリを作った場合（`app-config.json`）は、配信元の設定を最初に案内する。起動時に自動で確認（ネットワークがあれば）、「更新を確認」で手動確認。教材のダウンロードは必ずユーザー操作。
- 状態：未ダウンロード／待機中／ダウンロード中（進捗）／オフライン可／新しい版あり／失敗（再試行）。新規の講義は「新着」。ファイルが消えていれば（iPadOS による整理）未ダウンロードに戻す。
- ダウンロード：新しい版を `lw-lec-<新版>` にすべて取得し、サイズと SHA-256 を照合してから記録を切り替える（失敗しても使用中の版はそのまま。途中の残りは次回起動時に削除）。他の版に同じハッシュのファイルがあれば再利用。容量を事前に確認し、不足・保存失敗は通知。
- 更新の安全策：各ページの「署名」（ページの本文・属性・参照ファイル、ウィジェットのページは JS、PDF ページは PDF の内容のハッシュ）をダウンロード時に計算。**書き込みのあるページの署名が変わった（または消えた）ら旧版を残す**（`kept`）。ライブラリの ⋯ →「旧版で開く」（`lecture.html?l=…&v=<旧版>`）で書き込みと合った版を表示できる。新版でそのページを開くと案内を表示。
- 削除：教材だけ（書き込みは残す）／書き込みも、を選べる。旧版だけの削除も可。

### 6.7 改修時の確認
- `python tools/build.py --check`：教材の検証（エラー 0 件）。
- `python tools/serve.py` → `http://localhost:8000/tests/smoke.html` が **PASS 111**（ALL PASSED）になること（合成 Pointer イベントで手書き・消しゴム・Undo・パーム・指で書く・レーザー・テキスト・ページ移動・回転・PDF 出力・保存/復元・バックアップ・PDF 取り込みを検証）。ヘッドレス Chrome の `--virtual-time-budget` は rAF や PDF.js のワーカーが進まないので使わず、実時間で実行する。
- `http://localhost:8000/tests/offline.html` が **PASS 39**（Service Worker の「テスト用オフライン」で、ダウンロード → ネットワークなしでライブラリ・講義・数式フォント・画像・PDF・ウィジェット・書き込み・値と閲覧位置の復元・動画の Range、教材の更新と旧版保持・失敗時の保持・旧版削除、バックアップと復元、ファイル消失時の扱いを検証）。
- `pip install websocket-client` の上で `python tests/e2e_prod.py` が **ALL PASSED 27/27**（本番ビルドを `/repo/` 以下で配信 → ダウンロード → サーバを止めて動作 → アプリの新版を配信しても押すまで切り替わらない（完全に閉じて起動し直しても）→ 更新後も書き込み・教材が残る。続けて：教材なしのアプリ（--app-only）を配信し、教材は GitHub API の模擬サーバ（別オリジン・トークン必須・CORS）から取得、設定の案内・トークン誤り・ダウンロードして開く・未ダウンロードは開けない・バックアップにトークンなし・停止後も動作）。sw.js・pwa.js・ライブラリ・配信元を触ったら必ず実行。
- 実際の GitHub API について確認済み（2026-11）：ブラウザから `Authorization` 付きで CORS が通る、`application/vnd.github.raw+json` で本体が返る（`Content-Type` も同じ独自形式）、`git/ref/heads/<branch>` で SHA が取れる。
- 見た目は `tests/screens.html?l=...&p=6&w=820&h=1180&state=ink,menu` で確認（state: compact, menu, overview, eraser, hl, hand, laser, text, ink）。
- PDF 出力の確認：`lecture.html?l=...&print=view` をヘッドレス Chrome で print-to-pdf（`preferCSSPageSize`）。出来た PDF を一時的な講義に `@pdf` で読み込ませると画面で確認できる。
- iPad 実機でしか確認できないこと（Pencil の筆圧・追従、パーム、スクロールとの干渉、ホーム画面アプリ）は README の「実機チェックリスト」に従って確認を依頼する。
- **電池の消費**（古い iPad で授業 1 コマもつこと）：常に動き続けるタイマー・`requestAnimationFrame` のループを作らない（表示中・操作中・再生中だけ動かし、終わったら止める。監視などのタイマーは 1 秒以上の間隔で、背面では止める）。`mix-blend-mode` などの合成は必要なときだけ（蛍光ペンの層は線があるページだけ表示）。キャンバスは表示範囲だけ確保する。
- Safari の対応状況に注意：正規表現の後読み、`Array.prototype.findLast` 等の新しすぎる API は避ける。トップレベル await は使わない。

---

## 7. ロードマップ

- **Phase 1（実装済み）**：講義画面、KaTeX、手書き（ペン・蛍光ペン・消しゴム 2 種・Undo/Redo・全消去）、筆圧、パームリジェクション、動的グラフ・ウィジェット、ページ送り・一覧・白紙ページ・板書スペース拡張、背景、ツールバー最小化。
  - 前倒し：IndexedDB への自動保存と復元、JSON バックアップ、レーザーポインタ、テキストの書き込み、PDF 出力、PDF 教材の取り込み（`@pdf`）。
- **iPad 単独化（実装済み）**：PWA（ホーム画面・オフライン起動・明示的なアプリ更新）、GitHub Pages 配信と GitHub Actions、教材一覧の自動生成と検証、教材ライブラリ（科目・年度・最近使った・ダウンロード・版・削除）、旧版の保持、数値実験の値と閲覧位置の保存、全体バックアップ（.zip）と復元、保存容量の確認。
- **今後**：描画性能の実機チューニング、書式の拡充（段階表示 `::: step` など）、高度な手書き（投げ縄選択・移動、図形補正、蛍光ペンのみ消す消しゴム）、PDF 出力の用紙サイズ選択、旧版との差分表示。
