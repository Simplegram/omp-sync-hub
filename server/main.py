import os
import base64
import secrets
import sqlite3
import logging
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, Depends, Header, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DATA_DIR = os.environ.get("DATA_DIR", "/data")
STORAGE_DIR = os.path.join(DATA_DIR, "storage")
DB_PATH = os.path.join(DATA_DIR, "sync.db")
SERVER_SECRET = os.environ.get("SYNC_SECRET", "super-secret-omp-token")
DASHBOARD_USER = os.environ.get("DASHBOARD_USER", "admin")
DASHBOARD_PASS = os.environ.get("DASHBOARD_PASS", "adminpassword")

os.makedirs(STORAGE_DIR, exist_ok=True)
security = HTTPBasic()


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS devices (
            device_id  TEXT PRIMARY KEY,
            hostname   TEXT,
            os         TEXT,
            username   TEXT,
            last_sync  TIMESTAMP,
            sync_count INTEGER DEFAULT 0
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id  TEXT,
            action     TEXT,
            timestamp  TIMESTAMP,
            files_count INTEGER
        )
        """
    )
    conn.commit()
    conn.close()


init_db()

app = FastAPI(title="Oh My Pi Sync Server")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def verify_token(x_sync_token: Optional[str] = Header(None)):
    if x_sync_token != SERVER_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized")


def verify_auth(credentials: HTTPBasicCredentials = Depends(security)):
    is_user = secrets.compare_digest(credentials.username, DASHBOARD_USER)
    is_pass = secrets.compare_digest(credentials.password, DASHBOARD_PASS)
    if not (is_user and is_pass):
        raise HTTPException(status_code=401, detail="Unauthorized")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class SyncFile(BaseModel):
    path: str
    content: str  # base64 encoded
    mtime: float


class PushPayload(BaseModel):
    device_id: str
    hostname: str
    username: str
    os_info: str
    files: List[SyncFile]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def user_storage_dir(username: str) -> str:
    """Per-username storage root on the server."""
    safe = username.replace("\\", "_").replace("/", "_")
    d = os.path.join(STORAGE_DIR, safe)
    os.makedirs(d, exist_ok=True)
    return d


def file_group(rel_path: str) -> str:
    """Top-level path component, or 'config' for root-level files."""
    parts = rel_path.replace("\\", "/").split("/")
    if len(parts) == 1:
        return "config"
    return parts[0]


# ---------------------------------------------------------------------------
# API – Push
# ---------------------------------------------------------------------------
@app.post("/api/sync/push")
def push_files(payload: PushPayload, token: None = Depends(verify_token)):
    now = datetime.utcnow()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute(
        """
        INSERT INTO devices (device_id, hostname, os, username, last_sync, sync_count)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(device_id) DO UPDATE SET
            hostname=excluded.hostname,
            os=excluded.os,
            username=excluded.username,
            last_sync=excluded.last_sync,
            sync_count=sync_count + 1
        """,
        (payload.device_id, payload.hostname, payload.os_info, payload.username, now),
    )

    storage_root = user_storage_dir(payload.username)
    for item in payload.files:
        rel_path = item.path.replace("\\", "/").strip("/")
        dest_path = os.path.join(storage_root, rel_path)
        dest_dir = os.path.dirname(dest_path)
        if dest_dir:
            os.makedirs(dest_dir, exist_ok=True)
        with open(dest_path, "wb") as f:
            f.write(base64.b64decode(item.content))

    cur.execute(
        "INSERT INTO sync_history (device_id, action, timestamp, files_count) VALUES (?, 'push', ?, ?)",
        (payload.device_id, now, len(payload.files)),
    )
    conn.commit()
    conn.close()

    return {"status": "success", "files_received": len(payload.files), "time": str(now)}


# ---------------------------------------------------------------------------
# API – Pull
# ---------------------------------------------------------------------------
@app.get("/api/sync/pull")
def pull_files(
    device_id: str,
    username: str,
    hostname: str = "unknown",
    groups: Optional[str] = None,
    token: None = Depends(verify_token),
):
    storage_root = user_storage_dir(username)
    allowed_groups: Optional[set] = None
    if groups:
        allowed_groups = {g.strip() for g in groups.split(",") if g.strip()}

    files_to_send = []
    for root, _, files in os.walk(storage_root):
        for fname in files:
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, storage_root).replace("\\", "/")

            if allowed_groups is not None:
                if file_group(rel_path) not in allowed_groups:
                    continue

            stat = os.stat(full_path)
            with open(full_path, "rb") as f:
                b64_content = base64.b64encode(f.read()).decode("ascii")
            files_to_send.append(
                {"path": rel_path, "content": b64_content, "mtime": stat.st_mtime}
            )

    now = datetime.utcnow()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("UPDATE devices SET last_sync=? WHERE device_id=?", (now, device_id))
    cur.execute(
        "INSERT INTO sync_history (device_id, action, timestamp, files_count) VALUES (?, 'pull', ?, ?)",
        (device_id, now, len(files_to_send)),
    )
    conn.commit()
    conn.close()

    return {"files": files_to_send, "count": len(files_to_send)}


# ---------------------------------------------------------------------------
# API – Available groups
# ---------------------------------------------------------------------------
@app.get("/api/sync/available")
def available_groups(
    username: str,
    token: None = Depends(verify_token),
):
    """List file groups and file counts available for the given username."""
    storage_root = user_storage_dir(username)
    group_counts: dict = {}
    for root, _, files in os.walk(storage_root):
        for fname in files:
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, storage_root).replace("\\", "/")
            g = file_group(rel_path)
            group_counts[g] = group_counts.get(g, 0) + 1

    groups = [
        {"name": g, "files": c} for g, c in sorted(group_counts.items())
    ]
    return {"username": username, "groups": groups}


# ---------------------------------------------------------------------------
# API – Health
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health_check(token: None = Depends(verify_token)):
    return {"status": "ok", "service": "omp-sync-hub"}


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
def get_dashboard(auth: None = Depends(verify_auth)):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        "SELECT device_id, hostname, os, username, last_sync, sync_count FROM devices ORDER BY last_sync DESC"
    )
    devices = cur.fetchall()
    cur.execute(
        "SELECT device_id, action, timestamp, files_count FROM sync_history ORDER BY timestamp DESC LIMIT 50"
    )
    history = cur.fetchall()
    conn.close()

    device_rows = "\n".join(
        f"<tr><td>{d[0]}</td><td>{d[1]}</td><td>{d[2]}</td><td>{d[3] or '—'}</td><td>{d[4] or '—'}</td><td>{d[5]}</td></tr>"
        for d in devices
    )
    history_rows = "\n".join(
        f"<tr><td>{h[0]}</td><td>{h[1]}</td><td>{h[2]}</td><td>{h[3]}</td></tr>"
        for h in history
    )

    return f"""<!DOCTYPE html>
<html>
<head>
    <title>Oh My Pi Sync Hub</title>
    <style>
        body {{ font-family: system-ui, sans-serif; margin: 2rem; background: #0d1117; color: #c9d1d9; }}
        h1 {{ color: #58a6ff; }}
        table {{ border-collapse: collapse; width: 100%; margin-bottom: 2rem; }}
        th, td {{ padding: 8px 12px; border: 1px solid #30363d; text-align: left; }}
        th {{ background: #161b22; color: #58a6ff; }}
        tr:nth-child(even) {{ background: #161b22; }}
        .section {{ margin-bottom: 2rem; }}
    </style>
</head>
<body>
    <h1>Oh My Pi Sync Hub</h1>
    <div class="section">
        <h2>Devices</h2>
        <table>
            <thead><tr><th>ID</th><th>Hostname</th><th>OS</th><th>Username</th><th>Last Sync</th><th>Count</th></tr></thead>
            <tbody>{device_rows}</tbody>
        </table>
    </div>
    <div class="section">
        <h2>Recent Activity</h2>
        <table>
            <thead><tr><th>Device</th><th>Action</th><th>Time</th><th>Files</th></tr></thead>
            <tbody>{history_rows}</tbody>
        </table>
    </div>
</body>
</html>"""
