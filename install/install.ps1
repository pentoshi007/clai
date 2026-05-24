# clai installer for Windows (PowerShell)
# Usage: irm https://github.com/pentoshi007/clai/releases/latest/download/install.ps1 | iex
#
# Verifies the downloaded binary against the published SHA256 file
# (clai-bun-windows-<arch>.exe.sha256) before installing. Set the
# environment variable CLAI_SKIP_CHECKSUM=1 to bypass verification
# at your own risk.

$ErrorActionPreference = "Stop"

$repo = if ($env:CLAI_REPO) { $env:CLAI_REPO } else { "pentoshi007/clai" }
$installDir = if ($env:CLAI_BIN_DIR) { $env:CLAI_BIN_DIR } else { "$env:LOCALAPPDATA\clai" }
$skipChecksum = $env:CLAI_SKIP_CHECKSUM -eq "1"

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x64" }
$name = "clai-bun-windows-${arch}.exe"
$sumName = "${name}.sha256"

$url = "https://github.com/${repo}/releases/latest/download/${name}"
$sumUrl = "https://github.com/${repo}/releases/latest/download/${sumName}"

Write-Host "Downloading clai for windows-${arch}..." -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP "clai-download.exe"
$sumTmp = Join-Path $env:TEMP "clai-download.exe.sha256"

Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

if (-not $skipChecksum) {
    Write-Host "Verifying SHA256..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $sumUrl -OutFile $sumTmp -UseBasicParsing
    } catch {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        throw "Could not fetch checksum file from $sumUrl. Re-run with `$env:CLAI_SKIP_CHECKSUM=1` to bypass (not recommended)."
    }

    $expected = (Get-Content -Path $sumTmp -TotalCount 1).Split()[0].Trim()
    if ([string]::IsNullOrEmpty($expected)) {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        throw "Empty checksum file."
    }
    $actual = (Get-FileHash -Path $tmp -Algorithm SHA256).Hash.ToLower()
    $expectedLower = $expected.ToLower()

    if ($expectedLower -ne $actual) {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        Remove-Item $sumTmp -Force -ErrorAction SilentlyContinue
        throw "Checksum mismatch! expected=$expectedLower actual=$actual"
    }
    Write-Host "checksum ok ($actual)" -ForegroundColor Green
    Remove-Item $sumTmp -Force -ErrorAction SilentlyContinue
}

# Create install directory
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# Move binary
$dest = Join-Path $installDir "clai.exe"
Move-Item -Path $tmp -Destination $dest -Force

# Add to PATH if not already there
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$installDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$currentPath;$installDir", "User")
    Write-Host "Added $installDir to PATH (restart your terminal)" -ForegroundColor Yellow
}

Write-Host "Installed clai to $dest" -ForegroundColor Green
Write-Host "  Restart your terminal, then run 'clai' to get started." -ForegroundColor Gray
