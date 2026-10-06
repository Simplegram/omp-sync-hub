# omp-sync-hub – one-step Windows client installer (git-based)
# Usage:
#   irm https://raw.githubusercontent.com/Simplegram/omp-sync-hub/main/scripts/install.ps1 | iex
#   .\scripts\install.ps1 -GitUrl "git@github.com:Simplegram/omp-agent-config.git"

[CmdletBinding()]
param(
    [string]$GitUrl
)

# 1. OS check
if ($env:OS -ne "Windows_NT" -and $IsWindows -ne $true) {
    Write-Error "This installer only supports Windows. Detected: $env:OS"
    exit 1
}

# 2. Prompt for git URL if not provided
if (-not $GitUrl) {
    $GitUrl = Read-Host "Enter your agent config git URL (e.g. git@github.com:user/repo.git)"
}

# 3. Resolve agent directory
$AgentDir = Join-Path $env:USERPROFILE ".omp\agent"
$ExtDir   = Join-Path $AgentDir "extensions"
$EnvFile  = Join-Path $AgentDir ".env"
$ExtFile  = Join-Path $ExtDir "omp-sync.ts"

New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null

# 4. Write .env
$EnvContent = "OMP_GIT_URL=$GitUrl`n"
Set-Content -Path $EnvFile -Value $EnvContent -Encoding UTF8
Write-Host "  [OK] Wrote $EnvFile" -ForegroundColor Green

# 5. Install extension
$ScriptPath = $MyInvocation.MyCommand.Path
if ($ScriptPath) {
    $ScriptDir   = Split-Path -Parent $ScriptPath
    $RepoExtFile = Join-Path $ScriptDir "..\extension\omp-sync.ts"
    if (Test-Path $RepoExtFile) {
        Copy-Item -Path $RepoExtFile -Destination $ExtFile -Force
        Write-Host "  [OK] Copied extension from local repo to $ExtFile" -ForegroundColor Green
    } else {
        Write-Warning "Local extension not found. Falling back to download."
        Download-Extension $ExtFile
    }
} else {
    Download-Extension $ExtFile
}

function Download-Extension([string]$Target) {
    $RawUrl = "https://raw.githubusercontent.com/Simplegram/omp-sync-hub/main/extension/omp-sync.ts"
    Write-Host "  Downloading extension from $RawUrl ..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $RawUrl -OutFile $Target -UseBasicParsing
        Write-Host "  [OK] Downloaded extension to $Target" -ForegroundColor Green
    } catch {
        Write-Warning "Could not download: $_"
        Write-Warning "Manually copy extension/omp-sync.ts to $Target"
    }
}

# 6. Summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  omp-sync-hub client installed" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Git URL   : $GitUrl"
Write-Host "  Agent dir : $AgentDir"
Write-Host "  .env file : $EnvFile"
Write-Host "  Extension : $ExtFile"
Write-Host ""
Write-Host "  On next omp launch, the extension will:" -ForegroundColor Yellow
Write-Host "   - init git repo in $AgentDir if needed" -ForegroundColor Yellow
Write-Host "   - write .gitignore (excludes .env, agent.db, sessions, memories)" -ForegroundColor Yellow
Write-Host "   - pull configs on session_start, push on turn_end/shutdown" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Use /sync [push|pull|status|test] inside omp for manual sync." -ForegroundColor Yellow
Write-Host ""
