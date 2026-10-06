# omp-sync-hub

Sync your Oh My Pi (omp) agent configuration, skills, and extensions across machines using a private Git repo. No server to run, no Docker, no custom API.

## How It Works

A zero-dependency TypeScript extension (`omp-sync.ts`) is loaded by omp on every launch. It wraps your `~/.omp/agent/` directory in a git repo and syncs it to a private remote:

| Event | Action |
|-------|--------|
| `session_start` | `git pull --rebase --autostash origin main` (blocking) |
| `turn_end` | Debounced 2.5s → async `git add -A && commit && push` (non-blocking) |
| `session_shutdown` | Immediate `git add -A && commit && push` |
| `/sync push` | Manual push |
| `/sync pull` | Manual pull |
| `/sync status` | Show `git status` + recent commits |
| `/sync test` | Verify remote connectivity |

### What Gets Synced

Everything in `~/.omp/agent/` **except** what's in `.gitignore`:

| Synced | Excluded |
|--------|----------|
| `config.yml`, `config.yaml`, `models.yml` | `.env` (machine-specific secrets) |
| `memory_summary.md` | `agent.db` + WAL/SHM files |
| `skills/` (recursive) | `sessions/`, `memories/` |
| `extensions/` (recursive) | `extensions/omp-sync.ts` (the extension itself) |
| | `.cache/`, `tmp/`, `*.log` |
| | `.DS_Store`, `Thumbs.db` |

`shellPath` in `config.yml` is automatically migrated to `.env` as `OMP_SHELL_PATH` on first bootstrap, then stripped from synced configs before every push and re-injected after every pull. Each machine keeps its own shell path without conflicts.

## Setup

### 1. Create a Private Git Repo

```bash
gh repo create omp-agent-config --private
# or on GitHub: New Repository → omp-agent-config → Private
```

This repo stores your agent config data. It starts empty — the first machine to run omp will push its local files.

**Windows (one-liner):**
```powershell
irm https://raw.githubusercontent.com/Simplegram/omp-sync-hub/main/scripts/install.ps1 | iex
```

**Windows (from cloned repo):**
```powershell
git clone https://github.com/Simplegram/omp-sync-hub.git
cd omp-sync-hub
.\scripts\install.ps1 -GitUrl "git@github.com:Simplegram/omp-agent-config.git"
```

**Linux / macOS:**
```bash
curl -sL https://raw.githubusercontent.com/Simplegram/omp-sync-hub/main/scripts/install.sh | bash
# or:
git clone https://github.com/Simplegram/omp-sync-hub.git
cd omp-sync-hub
./scripts/install.sh git@github.com:Simplegram/omp-agent-config.git
```

The installer:
1. Writes `~/.omp/agent/.env` with your `OMP_GIT_URL`
2. Copies `omp-sync.ts` to `~/.omp/agent/extensions/`

### 3. Launch omp

On first launch the extension:
- Verifies `git` is in PATH
- Writes `.gitignore` to `~/.omp/agent/` (if missing)
- Migrates `shellPath` from `config.yml` to `.env` as `OMP_SHELL_PATH` (one-time)
- Runs `git init -b main` (if not already a repo)
- Sets local `user.name`/`user.email` (no global git config needed)
- Adds the remote
- If remote is empty: commits local files and pushes (first machine)
- If remote has commits: pulls (subsequent machines)

### 4. Add More Machines

On each new machine, run the installer with the same `OMP_GIT_URL`. The extension will `git pull` on first launch and pick up all configs, skills, and extensions.

## Client Environment Files

Two files work together:

| File | Synced? | Purpose |
|------|---------|---------|
| `.env` | No (gitignored) | Machine-specific: `OMP_GIT_URL`, `OMP_SHELL_PATH`, secrets |
| `.env.synced` | Yes (via git) | Shared values for all machines: API keys, service endpoints |

`.env` overrides `.env.synced` when the same variable is set in both.

| Variable | File | Description |
|----------|------|-------------|
| `OMP_GIT_URL` | `.env` | Git remote URL |
| `OMP_SHELL_PATH` | `.env` | Optional. Machine-specific shell path |
| `SEARXNG_ENDPOINT` | `.env.synced` | Shared service endpoint |
| `BRAVE_API_KEY` | `.env.synced` | Shared API key |
| `NTFY_SERVER` / `NTFY_TOPIC` | `.env.synced` | Notification service |

## Manual Setup

If you prefer not to use the installer:

1. Create `~/.omp/agent/.env`:
   ```
   OMP_GIT_URL=git@github.com:your-user/your-repo.git
   ```

2. (Optional) Create `~/.omp/agent/.env.synced` with shared values (API keys, service endpoints) that should be available on all machines.

3. Copy `extension/omp-sync.ts` to `~/.omp/agent/extensions/omp-sync.ts`.

4. Launch omp. The extension handles the rest.


## Repository Structure

```
omp-sync-hub/
├── .gitignore
├── README.md
├── extension/
│   ├── omp-sync.ts           # Zero-dep TypeScript client extension
│   └── client.env.example    # Client .env template
└── scripts/
    ├── install.ps1           # Windows installer (PowerShell)
    └── install.sh            # Linux/macOS installer (bash)
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `git not found in PATH` | Install git: `winget install Git.Git` (Windows) or `apt install git` / `brew install git` |
| `Permission denied (publickey)` | Add your SSH key to GitHub, or use HTTPS URL in `OMP_GIT_URL` |
| Remote repo doesn't exist | Create it: `gh repo create omp-agent-config --private` |
| Extension not loading | Confirm file is at `~/.omp/agent/extensions/omp-sync.ts` and `.env` exists at `~/.omp/agent/.env` |
| Push conflicts | The extension auto-rebases and retries once. If it fails, run `/sync pull` then `/sync push` |
| Files not syncing | Check `.gitignore` in `~/.omp/agent/` isn't excluding them |
