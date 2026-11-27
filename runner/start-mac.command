#!/bin/bash
# Lectoryx ローカル実行ツールを起動する（ダブルクリック）。使っている間はこのウィンドウを閉じないでください。
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.juliaup/bin:$PATH"
if ! command -v julia > /dev/null 2>&1; then
  echo "Julia が見つかりません。https://julialang.org/install/ から Julia をインストールしてください。"
  read -r -p "Enter キーで閉じます"
  exit 1
fi
exec julia --startup-file=no lectoryx-runner.jl --open "$@"
