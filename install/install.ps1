# clai installer for Windows (PowerShell)
# Usage: irm https://github.com/pentoshi007/clai/releases/latest/download/install.ps1 | iex

$ErrorActionPreference = "Stop"

$repo = if ($env:CLAI_REPO) { $env:CLAI_REPO } else { "pentoshi007/clai" }
$installDir = if ($env:CLAI_BIN_DIR) { $env:CLAI_BIN_DIR } else { "$env:LOCALAPPDATA\clai" }

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x64" }
$name = "clai-bun-windows-${arch}.exe"

$url = "https://github.com/${repo}/releases/latest/download/${name}"

Write-Host "Downloading clai for windows-${arch}..." -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP "clai-download.exe"

Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

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
