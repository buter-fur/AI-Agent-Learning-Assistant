@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 22.13 以上：https://nodejs.org
  pause
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)"
if errorlevel 1 (
  echo Node.js 版本太低，需要 22.13 以上
  pause
  exit /b 1
)
echo 目录：%cd%
echo.
node src\generate.mjs --check
echo.
pause
