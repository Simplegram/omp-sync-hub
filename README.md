# omp-sync-hub

Self-hosted synchronization server and Windows client extension for **Oh My Pi (omp)**. Keeps your agent configuration, models, skills, sessions, and (optionally) auth database in sync across all your machines through a single central server.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       omp-sync-hub                            │
│                                                              │
│  ┌──────────────┐         ┌──────────────────────────────┐  │
│  │  Server      │  HTTP   │  Windows Client (omp)         │  │
│  │  (Docker)    │◄───────►│  extension/omp-sync.ts        │  │
│  │              │  base64 │                                │  │
│  │  FastAPI     │  JSON   │  • Pull on session_start      │  │
│  │  + SQLite    │         │  • Push on turn_end (2.5s)    │  │
│  │  + Storage   │         │  • Push on session_shutdown   │  │
│  │  + Dashboard │         │  • /sync [push|pull] command  │  │
│  └──────────────┘         └──────────────────────────────┘  │
│        │                                                     │
│        ▼                                                     │
│  ./data/sync.db         ./data/storage/                      │
│  (devices, history)     (uploaded file tree)                 │
└──────────────────────────────────────────────────────────────┘
```

- **Server** (`server/main.py`): FastAPI app with SQLite persistence. Serves a push/pull API (token-authenticated) and a web dashboard (Basic Auth, Tailwind CSS).
- **Client** (`extension/omp-sync.ts`): Zero-dependency TypeScript extension loaded natively by omp. Reads `%USERPROFILE%\.omp\agent\.env` for credentials and syncs a defined set of files and directories.

### What Gets Synced

| Type | Paths |
|------|-------|
| Files | `config.yml`, `config.yaml`, `models.yml`, `memory_summary.md` |
| Files (optional) | `agent.db` (when `SYNC_AUTH_DB=true`) |
| Folders (recursive) | `skills/`, `extensions/`, `sessions/`, `memories/` |
| Always excluded | `.env`, `omp-sync.ts` |

## Repository Structure

```
omp-sync-hub/
├── .gitignore
├── .env.example              # Server environment template
├── docker-compose.yml
├── Dockerfile
├── README.md
├── server/
│   ├── requirements.txt
│   └── main.py               # FastAPI sync server + dashboard
├── extension/
│   ├── omp-sync.ts           # Zero-dep TypeScript client extension
│   └── client.env.example    # Client .env template
└── scripts/
    └── install.ps1           # One-step Windows client installer
```

## Server Deployment

### Prerequisites

- Docker + Docker Compose
- A static IP or hostname reachable from your client machines

### Setup

```bash
git clone https://github.com/<your-username>/omp-sync-hub.git
cd omp-sync-hub

cp .env.example .env
# Edit .env – set SYNC_SECRET, DASHBOARD_USER, DASHBOARD_PASS, PORT
nano .env

docker compose up -d
```

### Verify

- Dashboard: `http://<server-ip>:8000` (Basic Auth with your dashboard credentials)
- API health: `curl -H "x-sync-token: <your-secret>" http://<server-ip>:8000/api/sync/pull?device_id=test&hostname=test`

### Environment Variables (Server `.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `SYNC_SECRET` | Yes | Shared token for API auth (`x-sync-token` header) |
| `DASHBOARD_USER` | Yes | Username for the web dashboard (Basic Auth) |
| `DASHBOARD_PASS` | Yes | Password for the web dashboard |
| `PORT` | No | Host port to expose (default `8000`) |

## Windows Client Installation

### One-Liner (recommended)

Open PowerShell on any Windows machine:

```powershell
irm https://raw.githubusercontent.com/<OWNER>/omp-sync-hub/main/scripts/install.ps1 | iex
```

The script prompts for your server URL and secret, writes `%USERPROFILE%\.omp\agent\.env`, and downloads the extension into `%USERPROFILE%\.omp\agent\extensions\omp-sync.ts`.

### From a Cloned Repo

```powershell
git clone https://github.com/<your-username>/omp-sync-hub.git
cd omp-sync-hub
.\scripts\install.ps1 -ServerUrl http://<server-ip>:8000 -Secret <your-secret>
```

### Manual Setup

1. Create the agent `.env` file:
   ```powershell
   @'
   OMP_SYNC_URL=http://YOUR-SERVER-IP:8000
   OMP_SYNC_SECRET=your-random-strong-secret-token
   SYNC_AUTH_DB=true
   '@ | Out-File -Encoding utf8 "$env:USERPROFILE\.omp\agent\.env"
   ```

2. Copy `extension/omp-sync.ts` to `%USERPROFILE%\.omp\agent\extensions\omp-sync.ts`.

### Client `.env` Reference

| Variable | Description |
|----------|-------------|
| `OMP_SYNC_URL` | Base URL of your sync server |
| `OMP_SYNC_SECRET` | Must match the server's `SYNC_SECRET` |
| `SYNC_AUTH_DB` | `true`/`false` – include `agent.db` in sync |

## Sync Lifecycle

| Event | Action |
|-------|--------|
| `session_start` | Non-blocking **pull** from server |
| `turn_end` | Debounced **push** (2.5 s delay) to avoid flooding |
| `session_shutdown` | Immediate synchronous **push** |
| `/sync push` | Manual push (slash command) |
| `/sync pull` | Manual pull (slash command) |

## Dashboard

Access at `http://<server-ip>:<port>` with your `DASHBOARD_USER` / `DASHBOARD_PASS` credentials.

Shows:
- **Connected Instances** – hostname, OS, device ID, last sync time, total sync count
- **Synced Files** – full file inventory with paths and sizes

## API Reference

All API endpoints require the `x-sync-token` header matching `SYNC_SECRET`.

### `POST /api/sync/push`

```json
{
  "device_id": "a1b2c3d4e5",
  "hostname": "WORKSTATION-01",
  "os_info": "Windows (10.0.26200)",
  "files": [
    { "path": "config.yml", "content": "<base64>", "mtime": 1700000000.0 }
  ]
}
```

### `GET /api/sync/pull?device_id=<id>&hostname=<name>`

Returns:
```json
{
  "files": [
    { "path": "config.yml", "content": "<base64>", "mtime": 1700000000.0 }
  ],
  "count": 1
}
```

## Data Persistence

All server data lives in `./data/` (mounted as `/data` in Docker):

```
data/
├── sync.db           # SQLite: devices + sync_history tables
└── storage/          # Uploaded file tree
```

Back up this directory to preserve device registrations, sync history, and all synced files.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 Unauthorized` on API | Verify `x-sync-token` matches server `SYNC_SECRET` |
| Dashboard asks for credentials | Use `DASHBOARD_USER` / `DASHBOARD_PASS` from `.env` |
| Extension not loading | Confirm file is at `%USERPROFILE%\.omp\agent\extensions\omp-sync.ts` and `.env` exists at `%USERPROFILE%\.omp\agent\.env` |
| Files not appearing on server | Check server is reachable; verify `OMP_SYNC_URL` in client `.env` |
| `agent.db` not syncing | Set `SYNC_AUTH_DB=true` in client `.env` |
