# ====================================================================
# BodyCodi -> GCal Sync : Chrome 바로가기 영구 설치 스크립트
#
# 이 스크립트는:
#   1. 확장 파일을 %LOCALAPPDATA%\bodycodi-sync 로 복사 (이미 있으면 갱신)
#   2. 시스템의 모든 Chrome .lnk 바로가기를 찾아 --load-extension 플래그 주입
#   3. 결과: 어떤 방식으로 Chrome을 켜도 확장이 자동 로드됨 (재부팅 후에도 OK)
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
Write-Host "[1/3] 확장 파일 복사 중..." -ForegroundColor Cyan

if (-not (Test-Path $dstDir)) {
    New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
}

# 설치에 필요한 항목만 복사 (자기 자신, zip, .pem 등은 제외)
$excludeNames = @('SETUP-PERMANENT.ps1', 'INSTALL.bat', 'UNINSTALL.bat', 'bodycodi-sync.zip', '*.pem')
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
Write-Host "[2/3] Chrome 설치 위치 탐색 중..." -ForegroundColor Cyan

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
Write-Host "[3/3] Chrome 바로가기 수정 중..." -ForegroundColor Cyan

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
Write-Host "  💡 만약 'Disable developer mode extensions' 경고가 뜨면:"
Write-Host "     'Cancel' 또는 'X'를 눌러 닫으세요. 'Disable'을 누르지 마세요."
Write-Host ""
Write-Host "  🔄 되돌리려면 UNINSTALL.bat 을 실행하세요."
Write-Host ""

Read-Host "Enter 키를 눌러 종료"
