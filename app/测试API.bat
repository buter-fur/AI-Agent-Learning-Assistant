@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 目录：%cd%
echo.
node src\generate.mjs --check
echo.
pause
