@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 22.5 以上：https://nodejs.org
  pause
  exit /b 1
)
if not exist "data\cards.db" echo 提示：还没有卡片，先运行 node src\scan.mjs 和 node src\ingest.mjs
node src\serve.mjs --open
pause
