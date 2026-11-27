@echo off
rem Lectoryx ローカル実行ツールを起動する（ダブルクリック）。使っている間はこのウィンドウを閉じないでください。
chcp 65001 > nul
where julia > nul 2> nul
if errorlevel 1 (
  echo Julia が見つかりません。https://julialang.org/install/ から Julia をインストールしてください。
  pause
  exit /b 1
)
julia --startup-file=no "%~dp0lectoryx-runner.jl" --open %*
if errorlevel 1 pause
