<#
.SYNOPSIS
  One-step client-side installer for Oh My Pi Sync Hub on Windows.

.DESCRIPTION
  Creates %USERPROFILE%\.omp\agent\.env with server credentials and installs
  the omp-sync.ts extension. Works both from a cloned repo and standalone via
  `irm ... | iex`.

.PARAMETER ServerUrl
  Base URL of the sync server (e.g. http://192.168.1.10:8000).
  If omitted, the script prompts interactively.

.PARAMETER Secret
  The x-sync-token shared secret. Must match SYNC_SECRET on the server.
  If omitted, the script prompts interactively.

.PARAMETER SyncAuthDb
  "true" to also sync agent.db (provider auth sessions). Default: "true".

.PARAMETER RepoRawBase
  Raw GitHub base URL used to download omp-sync.ts when running standalone.
  Default: https://raw.githubusercontent.com/<OWNER>/omp-sync-hub/main
#>
[CmdletBinding()]
param(
    [string]$ServerUrl,
    [string]$Secret,
    [string]$SyncAuthDb = "true",
    [string]$RepoRawBase = "https://raw.githubusercontent.com/Simplegram/omp-sync-hub/main"
)

# ---------------------------------------------------------------------------
# 1. OS check
# ---------------------------------------------------------------------------
if ($env:OS -ne "Windows_NT" -and $IsWindows -ne $true) {
    Write-Error "This installer only supports Windows. Detected: $env:OS"
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Prompt for missing parameters
# ---------------------------------------------------------------------------
if (-not $ServerUrl) {
    $ServerUrl = Read-Host "Enter your sync server URL (e.g. http://192.168.1.10:8000)"
}
# Strip trailing slash for consistent .env value
$ServerUrl = $ServerUrl.TrimEnd('/')

if (-not $Secret) {
    $SecureInput = Read-Host "Enter your sync secret (x-sync-token)" -AsSecureString
    $Secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureInput))
}

# ---------------------------------------------------------------------------
# 3. Create agent directory structure
# ---------------------------------------------------------------------------
$AgentDir   = Join-Path $env:USERPROFILE ".omp\agent"
$ExtDir     = Join-Path $AgentDir "extensions"
$EnvFile    = Join-Path $AgentDir ".env"
$ExtFile    = Join-Path $ExtDir "omp-sync.ts"

New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null

# ---------------------------------------------------------------------------
# 4. Write .env with credentials
# ---------------------------------------------------------------------------
$EnvContent = @"
OMP_SYNC_URL=$ServerUrl
OMP_SYNC_SECRET=$Secret
SYNC_AUTH_DB=$SyncAuthDb
"@

Set-Content -Path $EnvFile -Value $EnvContent -Encoding UTF8
Write-Host "  [OK] Wrote $EnvFile" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 5. Install omp-sync.ts
# ---------------------------------------------------------------------------
# Strategy A: running from a cloned repo (script lives in scripts/ subdirectory)
# When piped via irm | iex, MyCommand.Path is null – skip local-repo strategy
$ScriptPath = $MyInvocation.MyCommand.Path
if ($ScriptPath) {
    $ScriptDir = Split-Path -Parent $ScriptPath
    $RepoExtFile = Join-Path $ScriptDir "..\extension\omp-sync.ts"
} else {
    $RepoExtFile = $null
}

if ($RepoExtFile -and (Test-Path $RepoExtFile)) {
    # Running from a cloned repository
    Copy-Item -Path $RepoExtFile -Destination $ExtFile -Force
    Write-Host "  [OK] Copied extension from local repo to $ExtFile" -ForegroundColor Green
} else {
    # Strategy B: standalone (irm | iex) – download from raw GitHub
    $RawUrl = "$RepoRawBase/extension/omp-sync.ts"
    Write-Host "  Downloading extension from $RawUrl ..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $RawUrl -OutFile $ExtFile -UseBasicParsing
        Write-Host "  [OK] Downloaded extension to $ExtFile" -ForegroundColor Green
    } catch {
        Write-Warning "Could not download from $RawUrl : $_"
        Write-Warning "Make sure you set -RepoRawBase to your actual repo raw URL."
        Write-Warning "You can also manually copy extension/omp-sync.ts to $ExtFile"
    }
}

# ---------------------------------------------------------------------------
# 6. Success summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  omp-sync-hub client installed" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Server URL : $ServerUrl"
Write-Host "  Agent dir  : $AgentDir"
Write-Host "  .env file  : $EnvFile"
Write-Host "  Extension  : $ExtFile"
Write-Host ""
Write-Host "  Oh My Pi will now automatically sync on launch, turn end," -ForegroundColor Yellow
Write-Host "  and shutdown. Use /sync [push|pull] inside omp for manual sync." -ForegroundColor Yellow
Write-Host ""
