# ====================================================================
# BodyCodi -> GCal Sync : Chrome 바로가기 영구 설치 스크립트
#
# 이 스크립트는:
#   1. 확장 파일을 %LOCALAPPDATA%\bodycodi-sync 로 복사 (이미 있으면 갱신)
#   2. 시스템의 모든 Chrome .lnk 바로가기를 찾아 --load-extension 플래그 주입
#   3. 결과: 어떤 방식으로 Chrome을 켜도 확장이 자동 로드됨 (재부팅 후에도 OK)
#   4. (v1.13.2) 10분마다 GitHub 에서 새 버전을 받아오는 작업 스케줄러 등록
#      -> 이후로는 GitHub main 에 올라간 버전이 각 PC에 자동 적용됨
# ====================================================================

$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dstDir = Join-Path $env:LOCALAPPDATA 'bodycodi-sync'

Write-Host ""
Write-Host "============================================================"
Write-Host "  BodyCodi -> GCal Sync 영구 설치 스크립트"
Write-Host "============================================================"
Write-Host ""
Write-Host "  원본 위치 : $srcDir"
Write-Host "  설치 위치 : $dstDir"
Write-Host ""

# ----- Step 1: 파일 복사 -----
Write-Host "[1/4] 확장 파일 복사 중..." -ForegroundColor Cyan

if (-not (Test-Path $dstDir)) {
    New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
}

# 설치에 필요한 항목만 복사 (자기 자신, zip, .pem 등은 제외)
$excludeNames = @('SETUP-PERMANENT.ps1', 'INSTALL.bat', 'UNINSTALL.bat', 'bodycodi-sync.zip', '*.pem', '.git', '.github', 'update.log')
Get-ChildItem -Path $srcDir -Recurse | Where-Object {
    $relPath = $_.FullName.Substring($srcDir.Length).TrimStart('\')
    $skip = $false
    foreach ($pattern in $excludeNames) {
        if ($_.Name -like $pattern) { $skip = $true; break }
    }
    -not $skip
} | ForEach-Object {
    $relPath = $_.FullName.Substring($srcDir.Length).TrimStart('\')
    $target = Join-Path $dstDir $relPath
    if ($_.PSIsContainer) {
        if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
    } else {
        $parent = Split-Path -Parent $target
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -Path $_.FullName -Destination $target -Force
    }
}
Write-Host "      파일 복사 완료." -ForegroundColor Green

# ----- Step 2: Chrome 실행 파일 위치 찾기 -----
Write-Host ""
Write-Host "[2/4] Chrome 설치 위치 탐색 중..." -ForegroundColor Cyan

$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chromeExe = $null
foreach ($c in $chromeCandidates) {
    if (Test-Path $c) { $chromeExe = $c; break }
}
if (-not $chromeExe) {
    Write-Host "      Chrome.exe 를 찾을 수 없습니다. 수동 설치가 필요합니다." -ForegroundColor Red
    Write-Host "      예상 위치: $($chromeCandidates -join ', ')"
} else {
    Write-Host "      Chrome 발견: $chromeExe" -ForegroundColor Green
}

# ----- Step 3: 모든 Chrome 바로가기에 --load-extension 플래그 주입 -----
Write-Host ""
Write-Host "[3/4] Chrome 바로가기 수정 중..." -ForegroundColor Cyan

$loadFlag = "--load-extension=`"$dstDir`""

$shortcutPaths = @(
    "$env:USERPROFILE\Desktop\Google Chrome.lnk",
    "$env:USERPROFILE\Desktop\Chrome.lnk",
    "$env:PUBLIC\Desktop\Google Chrome.lnk",
    "$env:PUBLIC\Desktop\Chrome.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk",
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Google Chrome.lnk",
    "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Google Chrome.lnk"
)

$wshell = New-Object -ComObject WScript.Shell
$modifiedCount = 0
$alreadyOk = 0
$notFound = 0

foreach ($lnk in $shortcutPaths) {
    if (-not (Test-Path $lnk)) { $notFound++; continue }
    try {
        $sc = $wshell.CreateShortcut($lnk)
        $currentArgs = "$($sc.Arguments)"
        if ($currentArgs -match "--load-extension=") {
            # 이미 다른 --load-extension 이 있다면 우리 것으로 교체 (혹시 옛 경로일 수도)
            $newArgs = ($currentArgs -replace '--load-extension="[^"]*"', $loadFlag).Trim()
            $newArgs = ($newArgs -replace '--load-extension=\S+', $loadFlag).Trim()
            if ($newArgs -eq $currentArgs.Trim()) {
                $alreadyOk++
                Write-Host "      이미 설정됨: $lnk" -ForegroundColor DarkGray
                continue
            }
            $sc.Arguments = $newArgs
        } else {
            $sc.Arguments = ($currentArgs + ' ' + $loadFlag).Trim()
        }
        $sc.Save()
        $modifiedCount++
        Write-Host "      수정 완료: $lnk" -ForegroundColor Green
    } catch {
        Write-Host "      수정 실패: $lnk ($_)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "      수정 $modifiedCount 개 / 이미 설정 $alreadyOk 개 / 없음 $notFound 개"

# ----- Step 4: 자동 업데이트 작업 스케줄러 등록 (10분마다, 창 없이) -----
Write-Host ""
Write-Host "[4/4] 자동 업데이트 등록 중..." -ForegroundColor Cyan

$taskName = 'BodyCodiSync-AutoUpdate'
$vbsPath  = Join-Path $dstDir 'AUTO-UPDATE.vbs'
if (-not (Test-Path $vbsPath)) {
    Write-Host "      AUTO-UPDATE.vbs 가 없어 자동 업데이트를 등록하지 못했습니다 (수동 배포만 가능)" -ForegroundColor Yellow
} else {
    $registered = $false
    # 1순위: ScheduledTasks 모듈 (Windows 8/2012 이상) — 경로에 공백이 있어도 안전
    try {
        $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbsPath`""
        $every10  = New-TimeSpan -Minutes 10
        $tOnce    = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval $every10
        $tLogon   = New-ScheduledTaskTrigger -AtLogOn
        $tLogon.Repetition = $tOnce.Repetition
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
                        -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($tOnce, $tLogon) -Settings $settings -Force | Out-Null
        $registered = $true
    } catch {
        Write-Host "      (ScheduledTasks 모듈 실패: $($_.Exception.Message) — schtasks 로 재시도)" -ForegroundColor DarkGray
    }
    # 2순위: schtasks.exe
    if (-not $registered) {
        try {
            $argLine = "/Create /F /SC MINUTE /MO 10 /TN $taskName /TR `"wscript.exe \`"$vbsPath\`"`""
            $p = Start-Process -FilePath 'schtasks.exe' -ArgumentList $argLine -Wait -NoNewWindow -PassThru
            if ($p.ExitCode -eq 0) { $registered = $true }
        } catch {}
    }
    if ($registered) {
        Write-Host "      등록 완료: 10분마다 GitHub 에서 새 버전 확인 (작업 이름: $taskName)" -ForegroundColor Green
        try { Start-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch { & schtasks.exe /Run /TN $taskName 2>&1 | Out-Null }
        Write-Host "      첫 확인을 지금 실행했습니다. 결과는 $dstDir\update.log 에서 볼 수 있습니다." -ForegroundColor DarkGray
    } else {
        Write-Host "      등록 실패 — 자동 업데이트 없이 설치만 완료됩니다 (수동 배포 가능)" -ForegroundColor Yellow
    }
}

# ----- 마무리 안내 -----
Write-Host ""
Write-Host "============================================================"
Write-Host "  설치 완료!" -ForegroundColor Green
Write-Host "============================================================"
Write-Host ""
Write-Host "  ⚠️ 작업표시줄의 Chrome 아이콘은 수동 작업이 필요합니다:"
Write-Host "     1. 현재 작업표시줄의 Chrome 아이콘 우클릭 -> 작업표시줄에서 제거"
Write-Host "     2. 데스크탑/시작메뉴의 Chrome 아이콘을 다시 작업표시줄에 고정"
Write-Host "     (이미 수정된 바로가기를 핀해야 플래그가 유지됩니다)"
Write-Host ""
Write-Host "  ✅ 이제 다음 동작을 확인할 수 있습니다:"
Write-Host "     - Chrome을 완전히 종료 후 (작업관리자에서 chrome.exe 0개)"
Write-Host "     - 데스크탑/시작메뉴의 Chrome 아이콘 클릭"
Write-Host "     - chrome://extensions 열기"
Write-Host "     - 'BodyCodi -> Google Calendar Sync' 가 자동 로드되어 있어야 함"
Write-Host ""
Write-Host "  🔄 이후 업데이트는 자동입니다: GitHub main 에 새 버전이 올라가면"
Write-Host "     10분 안에 이 PC에 내려받아지고, 확장이 1분 안에 다시 불러옵니다."
Write-Host "     (저장소가 비공개라면 이 폴더에 github-token.txt 가 필요 — README 참고)"
Write-Host ""
Write-Host "  💡 만약 'Disable developer mode extensions' 경고가 뜨면:"
Write-Host "     'Cancel' 또는 'X'를 눌러 닫으세요. 'Disable'을 누르지 마세요."
Write-Host ""
Write-Host "  🔄 되돌리려면 UNINSTALL.bat 을 실행하세요."
Write-Host ""

Read-Host "Enter 키를 눌러 종료"
