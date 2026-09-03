@echo off
chcp 65001 >nul
setlocal

REM ============================================================
REM  BodyCodi -> GCal Sync : 영구 설치 (Chrome 바로가기 수정)
REM
REM  PowerShell 스크립트를 실행 정책 우회로 호출합니다.
REM  관리자 권한 불필요 — 사용자 프로필 안에서만 작업합니다.
REM ============================================================

echo.
echo ============================================================
echo   BodyCodi -^> GCal Sync 영구 설치
echo ============================================================
echo.
echo   이 스크립트는 다음을 수행합니다:
echo     1. 확장 파일을 %%LOCALAPPDATA%%\bodycodi-sync 로 복사
echo     2. Chrome 바로가기에 --load-extension 플래그 자동 주입
echo        (Chrome을 켤 때마다 확장이 자동 로드됨)
echo.
echo   계속하시려면 Enter, 취소하려면 Ctrl+C
pause >nul

REM PowerShell 스크립트 실행 (실행 정책 우회)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0SETUP-PERMANENT.ps1"

endlocal
