# ====================================================================
# BodyCodi -> GCal Sync : 크롬 웹스토어 "첫 업로드용" ZIP 만들기
#
# 하는 일:
#   1. 확장 파일만 골라 담는다 (manifest.json, *.js, *.html, *.css, icons)
#   2. manifest.json 의 "key" 줄을 뺀다 (웹스토어는 이 줄을 받지 않음)
#   3. 관리자 보관용 개인키(.pem)를 찾아 ZIP 맨 위에 key.pem 으로 넣는다
#      -> 첫 업로드 때 지금 쓰는 확장 ID(clgekekmmlpiggplilhgagfkepepjelk)를
#         그대로 이어받기 위한 것. 그래야 구글 로그인 설정을 바꿀 필요가 없다.
#   4. 바탕화면에 bodycodi-sync-store-FIRST-v{버전}.zip 을 만든다
#
# 개인키는 이 PC 안에서만 ZIP에 들어가며, 인터넷 어디에도 올리지 않는다.
# (ZIP 자체를 웹스토어 대시보드에 올리는 것만 예외)
# ====================================================================

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$storeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$extDir   = Split-Path -Parent $storeDir
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

Write-Host ''
Write-Host '============================================================'
Write-Host '  크롬 웹스토어 첫 업로드용 ZIP 만들기'
Write-Host '============================================================'
Write-Host ''

# ----- 1. manifest 읽기 -----
$manifestPath = Join-Path $extDir 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "manifest.json 을 찾을 수 없습니다: $extDir" }
$manifestText = [System.IO.File]::ReadAllText($manifestPath, $utf8NoBom)
$version = ($manifestText | ConvertFrom-Json).version
Write-Host "  확장 버전 : v$version"

# "key" 줄 제거
$storeManifest = [regex]::Replace($manifestText, '(?m)^[ \t]*"key"[ \t]*:[ \t]*"[^"]*",[ \t]*\r?\n', '')
if ($storeManifest -match '"key"\s*:') { throw 'manifest.json 에서 key 줄을 빼지 못했습니다' }

# ----- 2. 개인키 찾기 -----
Write-Host ''
Write-Host '[1/3] 관리자 보관용 개인키(.pem) 찾는 중...' -ForegroundColor Cyan
$searchRoots = @(
    (Split-Path -Parent $extDir),
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:USERPROFILE 'Downloads'),
    [Environment]::GetFolderPath('MyDocuments'),
    $env:USERPROFILE
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

$pem = $null
foreach ($root in $searchRoots) {
    $hit = Get-ChildItem -Path $root -Recurse -Depth 4 -Filter '*PRIVATE_KEY*.pem' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $pem = $hit.FullName; break }
}
if (-not $pem) {
    Write-Host '      자동으로 찾지 못했습니다. 파일 선택 창에서 직접 골라 주세요.' -ForegroundColor Yellow
    Write-Host '      (파일 이름: bodycodi-sync_PRIVATE_KEY_관리자보관용.pem)' -ForegroundColor Yellow
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title  = '관리자 보관용 개인키(.pem) 선택'
    $dlg.Filter = 'PEM 개인키 (*.pem)|*.pem'
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $pem = $dlg.FileName }
}

$includeKey = $false
if ($pem) {
    $pemText = [System.IO.File]::ReadAllText($pem)
    if ($pemText -match 'PRIVATE KEY') {
        $includeKey = $true
        Write-Host "      찾음: $pem" -ForegroundColor Green
    } else {
        Write-Host "      선택한 파일이 개인키가 아닙니다: $pem" -ForegroundColor Yellow
    }
}
if (-not $includeKey) {
    Write-Host '      개인키 없이 만듭니다. 이 경우 확장 ID가 새로 정해지므로' -ForegroundColor Yellow
    Write-Host '      구글 로그인(OAuth) 설정을 한 번 새로 해야 합니다 (안내서 B안).' -ForegroundColor Yellow
}

# ----- 3. ZIP 만들기 (경로 구분자는 / 로 고정) -----
Write-Host ''
Write-Host '[2/3] ZIP 만드는 중...' -ForegroundColor Cyan
$desktop = [Environment]::GetFolderPath('Desktop')
$suffix  = if ($includeKey) { 'FIRST' } else { 'NOKEY' }
$zipPath = Join-Path $desktop ("bodycodi-sync-store-{0}-v{1}.zip" -f $suffix, $version)
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

$files = @()
$files += Get-ChildItem -Path $extDir -File | Where-Object { $_.Extension -in '.js', '.html', '.css' }
$files += Get-ChildItem -Path (Join-Path $extDir 'icons') -File -Filter '*.png'

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
    $entry  = $zip.CreateEntry('manifest.json')
    $writer = New-Object System.IO.StreamWriter($entry.Open(), $utf8NoBom)
    $writer.Write($storeManifest); $writer.Dispose()
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($extDir.Length).TrimStart('\', '/') -replace '\\', '/'
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel) | Out-Null
        Write-Host "      + $rel"
    }
    if ($includeKey) {
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $pem, 'key.pem') | Out-Null
        Write-Host '      + key.pem (확장 ID 유지용)'
    }
} finally {
    $zip.Dispose()
}

Write-Host ''
Write-Host '[3/3] 완료' -ForegroundColor Cyan
Write-Host ''
Write-Host '============================================================'
Write-Host "  바탕화면에 만들어졌습니다:" -ForegroundColor Green
Write-Host "  $zipPath" -ForegroundColor Green
Write-Host '============================================================'
Write-Host ''
Write-Host '  다음: 안내서 3단계대로 이 ZIP을 웹스토어 대시보드에 올리세요.'
Write-Host '  주의: 이 ZIP에는 개인키가 들어 있습니다. 대시보드 업로드 외에는'
Write-Host '        메일/메신저/드라이브 등 어디에도 보내지 마세요.'
Write-Host ''
Read-Host 'Enter 키를 눌러 종료'
