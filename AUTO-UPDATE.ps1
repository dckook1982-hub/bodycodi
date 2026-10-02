# ====================================================================
# BodyCodi -> GCal Sync : 자동 업데이트 (GitHub -> 이 PC 확장 폴더)
#
# 동작:
#   1. GitHub 저장소(main 브랜치)의 manifest.json 버전을 조회
#   2. 이 PC에 설치된 버전보다 높으면 저장소 ZIP을 내려받아 확장 폴더에 덮어씀
#      (manifest.json 은 맨 마지막에 복사 -> 확장의 자동 리로드가 파일이 모두 갖춰진 뒤 1회만 발생)
#   3. 결과를 update.log 에 기록
#
# 실행: Windows 작업 스케줄러가 10분마다 AUTO-UPDATE.vbs 를 통해 창 없이 실행
#       (SETUP-PERMANENT.ps1 이 등록, UNINSTALL.bat 이 해제)
#
# 비공개 저장소인 경우: 이 폴더에 github-token.txt (읽기 전용 토큰 한 줄) 를 두면
#       그 토큰으로 인증한다. 저장소가 공개(public)이면 토큰이 필요 없다.
# ====================================================================

$ErrorActionPreference = 'Stop'
$Repo   = 'dckook1982-hub/bodycodi'
$Branch = 'main'

$dir      = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$logFile  = Join-Path $dir 'update.log'
$tokenTxt = Join-Path $dir 'github-token.txt'

function Log([string]$msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    try {
        $prev = @()
        if (Test-Path $logFile) { $prev = Get-Content $logFile -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 199 }
        Set-Content -Path $logFile -Value (@($prev) + $line) -Encoding UTF8
    } catch {}
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    # ----- 로컬 버전 -----
    $localManifest = Join-Path $dir 'manifest.json'
    if (-not (Test-Path $localManifest)) { Log "manifest.json 없음: $dir"; exit 0 }
    $localVer = [version]((Get-Content $localManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version)

    # ----- 요청 헤더 (공개 저장소면 토큰 불필요) -----
    $headers = @{ 'User-Agent' = 'bodycodi-sync-updater'; 'Accept' = 'application/vnd.github.raw' }
    if (Test-Path $tokenTxt) {
        $tok = (Get-Content $tokenTxt -Raw).Trim()
        if ($tok) { $headers['Authorization'] = "Bearer $tok" }
    }

    # ----- 원격 버전 -----
    $manifestUrl = "https://api.github.com/repos/$Repo/contents/manifest.json?ref=$Branch"
    try {
        $remoteObj = Invoke-RestMethod -Uri $manifestUrl -Headers $headers -UseBasicParsing -TimeoutSec 30
        if ($remoteObj -is [string]) { $remoteObj = $remoteObj | ConvertFrom-Json }
        elseif ($remoteObj -is [byte[]]) { $remoteObj = [Text.Encoding]::UTF8.GetString($remoteObj) | ConvertFrom-Json }
    } catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch {}
        if ($code -eq 404 -or $code -eq 401 -or $code -eq 403) {
            Log "원격 버전 조회 실패 (HTTP $code) — 저장소가 비공개라면 github-token.txt 가 필요하거나, 저장소를 공개로 바꿔야 합니다"
        } else {
            Log "원격 버전 조회 실패: $($_.Exception.Message)"
        }
        exit 0
    }
    $remoteVer = [version]$remoteObj.version

    if ($remoteVer -le $localVer) {
        # 최신 상태 — 로그가 쌓이지 않도록 조용히 종료
        exit 0
    }
    Log "새 버전 발견: v$localVer -> v$remoteVer. 내려받는 중..."

    # ----- ZIP 다운로드 + 압축 해제 -----
    $tmp = Join-Path $env:TEMP ("bodycodi-sync-update-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $zipPath = Join-Path $tmp 'repo.zip'
    $zipUrl  = "https://api.github.com/repos/$Repo/zipball/$Branch"
    $zipHeaders = @{ 'User-Agent' = 'bodycodi-sync-updater' }
    if ($headers.ContainsKey('Authorization')) { $zipHeaders['Authorization'] = $headers['Authorization'] }
    Invoke-WebRequest -Uri $zipUrl -Headers $zipHeaders -OutFile $zipPath -UseBasicParsing -TimeoutSec 120

    $extract = Join-Path $tmp 'x'
    Expand-Archive -Path $zipPath -DestinationPath $extract -Force

    $srcManifest = Get-ChildItem -Path $extract -Recurse -Filter 'manifest.json' | Select-Object -First 1
    if (-not $srcManifest) { throw 'ZIP 안에 manifest.json 이 없습니다' }
    $src = $srcManifest.Directory.FullName

    # 받은 ZIP의 버전이 정말 원격 버전인지 재확인 (중간 상태 방지)
    $zipVer = [version]((Get-Content $srcManifest.FullName -Raw -Encoding UTF8 | ConvertFrom-Json).version)
    if ($zipVer -ne $remoteVer) { throw "ZIP 버전($zipVer)이 원격 버전($remoteVer)과 다릅니다" }

    # ----- 복사 (설치 스크립트/키/토큰/로그 제외, manifest.json 은 마지막) -----
    $skip = @('INSTALL.bat', 'UNINSTALL.bat', 'SETUP-PERMANENT.ps1', 'github-token.txt', 'update.log', '*.pem', '.git*', '.github')
    $files = Get-ChildItem -Path $src -Recurse -File | Where-Object {
        $f = $_; -not ($skip | Where-Object { $f.Name -like $_ }) -and ($f.FullName -notmatch '[\\/]\.git[\\/]')
    }
    $copied = 0
    foreach ($f in ($files | Where-Object { $_.Name -ne 'manifest.json' })) {
        $rel    = $f.FullName.Substring($src.Length).TrimStart('\', '/')
        $target = Join-Path $dir $rel
        $parent = Split-Path -Parent $target
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -Path $f.FullName -Destination $target -Force
        $copied++
    }
    Copy-Item -Path $srcManifest.FullName -Destination $localManifest -Force
    $copied++

    Log "업데이트 완료: v$localVer -> v$remoteVer ($copied 개 파일). 크롬 확장이 1분 내 자동으로 다시 불러옵니다"
} catch {
    Log "업데이트 실패: $($_.Exception.Message)"
} finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
