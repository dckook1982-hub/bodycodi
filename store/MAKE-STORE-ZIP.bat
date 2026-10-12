@echo off
chcp 65001 >nul
REM 크롬 웹스토어 첫 업로드용 ZIP 만들기 (더블클릭)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0MAKE-STORE-ZIP.ps1"
