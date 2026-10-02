@echo off
chcp 65001 >nul
setlocal

echo.
echo ============================================================
echo   BodyCodi -^> GCal Sync 제거
echo ============================================================
echo.
echo   이 스크립트는 다음을 수행합니다:
echo     1. Chrome 바로가기에서 --load-extension 플래그 제거
echo     2. 자동 업데이트 작업 스케줄러 해제
echo     3. %%LOCALAPPDATA%%\bodycodi-sync 폴더 삭제
echo.
echo   계속하시려면 Enter, 취소하려면 Ctrl+C
pause >nul

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& {
    $ErrorActionPreference = 'Continue';
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;

    $dstDir = Join-Path $env:LOCALAPPDATA 'bodycodi-sync';

    Write-Host '';
    Write-Host '[1/2] Chrome 바로가기에서 --load-extension 제거 중...' -ForegroundColor Cyan;
    $shortcuts = @(
        \"$env:USERPROFILE\Desktop\Google Chrome.lnk\",
        \"$env:USERPROFILE\Desktop\Chrome.lnk\",
        \"$env:PUBLIC\Desktop\Google Chrome.lnk\",
        \"$env:PUBLIC\Desktop\Chrome.lnk\",
        \"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk\",
        \"$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk\",
        \"$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Google Chrome.lnk\"
    );
    $wshell = New-Object -ComObject WScript.Shell;
    $cleaned = 0;
    foreach ($lnk in $shortcuts) {
        if (-not (Test-Path $lnk)) { continue }
        try {
            $sc = $wshell.CreateShortcut($lnk);
            $args = $sc.Arguments;
            if ($args -match 'bodycodi-sync') {
                $newArgs = ($args -replace '--load-extension=\"[^\"]*bodycodi-sync[^\"]*\"', '').Trim();
                $newArgs = ($newArgs -replace '--load-extension=\S*bodycodi-sync\S*', '').Trim();
                $newArgs = ($newArgs -replace '\s+', ' ');
                $sc.Arguments = $newArgs;
                $sc.Save();
                $cleaned++;
                Write-Host (\"      정리됨: \" + $lnk) -ForegroundColor Green;
            }
        } catch {
            Write-Host (\"      실패: \" + $lnk + \" (\" + $_ + \")\") -ForegroundColor Yellow;
        }
    }
    Write-Host (\"      바로가기 \" + $cleaned + ' 개 정리됨.');

    Write-Host '';
    Write-Host '[2/3] 자동 업데이트 작업 해제 중...' -ForegroundColor Cyan;
    Unregister-ScheduledTask -TaskName 'BodyCodiSync-AutoUpdate' -Confirm:$false -ErrorAction SilentlyContinue;
    & schtasks.exe /Delete /F /TN 'BodyCodiSync-AutoUpdate' 2>&1 | Out-Null;
    Write-Host '      해제됨 (등록되어 있지 않았다면 무시)' -ForegroundColor Green;

    Write-Host '';
    Write-Host '[3/3] 확장 폴더 삭제 중...' -ForegroundColor Cyan;
    if (Test-Path $dstDir) {
        Remove-Item -Path $dstDir -Recurse -Force;
        Write-Host (\"      삭제됨: \" + $dstDir) -ForegroundColor Green;
    } else {
        Write-Host (\"      이미 없음: \" + $dstDir) -ForegroundColor DarkGray;
    }

    Write-Host '';
    Write-Host '============================================================';
    Write-Host '  제거 완료!' -ForegroundColor Green;
    Write-Host '============================================================';
    Write-Host '';
    Write-Host '  - chrome://extensions 에서도 카드를 수동 제거하세요.';
    Write-Host '  - 작업표시줄 Chrome 아이콘은 우클릭 -> 작업표시줄에서 제거 후 재추가';
    Write-Host '';
    Read-Host 'Enter 키를 눌러 종료';
}"

endlocal
