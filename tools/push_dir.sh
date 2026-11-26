#!/usr/bin/env bash
# フォルダの中身を、指定したリポジトリのブランチに 1 コミットとして push する（GitHub Actions 用）。
#   usage: tools/push_dir.sh <フォルダ> <リモート URL> <ブランチ> <コミットメッセージ>
# ・既存のブランチがあれば、その履歴の上に積む（古い版の教材も履歴に残る）。
# ・中身が前回と同じならコミットしない。
set -euo pipefail
DIR="$1"; REMOTE="$2"; BRANCH="$3"; MSG="$4"
cd "$DIR"
rm -rf .git
git init -q
# 改行コードの変換をしない（catalog.json の SHA-256 とファイルの中身を一致させるため）
echo '* -text' > .git/info/attributes
git config core.autocrlf false
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
if git fetch -q --depth=1 "$REMOTE" "$BRANCH" 2>/dev/null; then
  git reset -q --soft FETCH_HEAD
fi
git add -A
if git rev-parse -q --verify HEAD >/dev/null && git diff --cached --quiet; then
  echo "$BRANCH: 変更なし"
  exit 0
fi
git commit -q -m "$MSG"
git push -q "$REMOTE" "HEAD:refs/heads/$BRANCH"
echo "$BRANCH: push しました"
