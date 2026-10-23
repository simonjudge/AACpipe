param(
    [switch]$SkipBridge
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$output = Join-Path $root 'release\aacpipe-ocr'
$cache = Join-Path $root 'build\ocr-cache'
$model = Join-Path $cache 'eng.traineddata'
$modelHash = '7D4322BD2A7749724879683FC3912CB542F19906C83BCC1A52132556427170B2'
$modelRevision = '87416418657359cb625c412a48b6e1d6d41c29bd'
New-Item -ItemType Directory -Force $cache | Out-Null
if (!(Test-Path $model)) {
    Invoke-WebRequest "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$modelRevision/eng.traineddata" -OutFile $model
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$modelStream = [System.IO.File]::OpenRead($model)
try {
    $actualHash = [System.BitConverter]::ToString($sha256.ComputeHash($modelStream)).Replace('-', '')
}
finally {
    $modelStream.Dispose()
    $sha256.Dispose()
}
if ($actualHash -ne $modelHash) {
    throw "OCR model checksum mismatch. Remove only $model and rebuild."
}

Push-Location $root
try {
    if (!$SkipBridge) {
        & node scripts\build-bridge.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Bridge build failed.' }
    }
    & dotnet publish apps\ocr\AACpipe.Ocr.csproj --configuration Release --runtime win-x64 --self-contained true --output $output
    if ($LASTEXITCODE -ne 0) { throw 'OCR publish failed.' }
    New-Item -ItemType Directory -Force (Join-Path $output 'tessdata') | Out-Null
    Copy-Item $model (Join-Path $output 'tessdata\eng.traineddata')
    Copy-Item (Join-Path $root 'target\release\aacpipe-bridge.exe') $output
    Copy-Item (Join-Path $root 'LICENSE') $output
    Copy-Item (Join-Path $PSScriptRoot 'ocr-THIRD-PARTY-NOTICES.txt') $output
    Copy-Item (Join-Path $root 'docs\ocr.md') (Join-Path $output 'OCR-SETUP.md')
    Write-Output "Standalone OCR companion: $output\aacpipe-ocr.exe"
    Write-Output 'Distribute the entire folder, not just the executable.'
}
finally { Pop-Location }
