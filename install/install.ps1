# clai installer for Windows (PowerShell)
# Usage: irm https://downloads.clai.aniketpandey.website/install/install.ps1 | iex
#
# Downloads from the Cloudflare R2 mirror (fast global CDN) with automatic
# fallback to GitHub releases. Verifies the downloaded binary against the
# published SHA256 file (clai-bun-windows-<arch>.exe.sha256) fetched from
# GitHub releases before installing. Set CLAI_NO_MIRROR=1 to download
# straight from GitHub, CLAI_DOWNLOAD_BASE to point at a different mirror,
# or CLAI_SKIP_CHECKSUM=1 to bypass verification at your own risk.

$ErrorActionPreference = "Stop"

$repo = if ($env:CLAI_REPO) { $env:CLAI_REPO } else { "pentoshi007/clai" }
$installDir = if ($env:CLAI_BIN_DIR) { $env:CLAI_BIN_DIR } else { "$env:LOCALAPPDATA\clai" }
if (-not $installDir -or [string]::IsNullOrWhiteSpace($installDir)) {
    $installDir = Join-Path $env:USERPROFILE '.clai\bin'
}
$skipChecksum = $env:CLAI_SKIP_CHECKSUM -eq "1"
$noMirror = $env:CLAI_NO_MIRROR -eq "1"
$mirrorBase = if ($env:CLAI_DOWNLOAD_BASE) { $env:CLAI_DOWNLOAD_BASE.Trim().TrimEnd('/') } else { "https://downloads.clai.aniketpandey.website" }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } elseif ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x64" }
$name = "clai-bun-windows-${arch}.exe"
$sumName = "${name}.sha256"

$ghUrl = "https://github.com/${repo}/releases/latest/download/${name}"
$ghSumUrl = "https://github.com/${repo}/releases/latest/download/${sumName}"
$mirrorUrl = "${mirrorBase}/latest/${name}"
$mirrorSumUrl = "${mirrorBase}/latest/${sumName}"

$tmp = Join-Path $env:TEMP "clai-download.exe"
$sumTmp = Join-Path $env:TEMP "clai-download.exe.sha256"

$headers = @{
    "Cache-Control" = "no-cache, no-store"
    "Pragma" = "no-cache"
}

$downloaded = $false
if (-not $noMirror) {
    Write-Host "Downloading clai for windows-${arch} from the Cloudflare R2 mirror..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $mirrorUrl -OutFile $tmp -UseBasicParsing -Headers $headers
        $downloaded = $true
    } catch {
        Write-Host "Mirror unavailable, falling back to GitHub releases..." -ForegroundColor Yellow
    }
}
if (-not $downloaded) {
    Write-Host "Downloading clai for windows-${arch} from GitHub..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ghUrl -OutFile $tmp -UseBasicParsing -Headers $headers
}

if (-not $skipChecksum) {
    Write-Host "Verifying SHA256..." -ForegroundColor Cyan
    $sumFetched = $false
    try {
        Invoke-WebRequest -Uri $ghSumUrl -OutFile $sumTmp -UseBasicParsing -Headers $headers
        $sumFetched = $true
    } catch {
        if (-not $noMirror) {
            try {
                Invoke-WebRequest -Uri $mirrorSumUrl -OutFile $sumTmp -UseBasicParsing -Headers $headers
                $sumFetched = $true
            } catch {
                $sumFetched = $false
            }
        }
    }
    if (-not $sumFetched) {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        throw "Could not fetch checksum file from $ghSumUrl. Re-run with `$env:CLAI_SKIP_CHECKSUM=1` to bypass (not recommended)."
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

# Verify the binary works
try {
    $verOutput = & $dest --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Verified: clai $verOutput" -ForegroundColor Green
    } else {
        Write-Host "  Warning: clai installed but --version returned exit code $LASTEXITCODE" -ForegroundColor Yellow
        Write-Host "  This may resolve after restarting your terminal." -ForegroundColor Gray
    }
} catch {
    Write-Host "  Warning: Could not verify installation: $_" -ForegroundColor Yellow
    Write-Host "  Restart your terminal and try: clai --version" -ForegroundColor Gray
}

Write-Host ""
Write-Host "Installed clai to $dest" -ForegroundColor Green
Write-Host "  Restart your terminal, then run 'clai' to get started." -ForegroundColor Gray
Write-Host "  For help: clai --help  |  Diagnostics: clai doctor" -ForegroundColor Gray
