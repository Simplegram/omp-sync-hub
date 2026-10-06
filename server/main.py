import os
import json
import sqlite3
import base64
import secrets
from datetime import datetime
from typing import Optional, List

from fastapi import FastAPI, Header, HTTPException, Depends
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
    cur.execute("""
        CREATE TABLE IF NOT EXISTS devices (
            device_id TEXT PRIMARY KEY,
            hostname TEXT,
            os TEXT,
            last_sync TIMESTAMP,
            sync_count INTEGER DEFAULT 0
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS sync_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT,
            action TEXT,
            timestamp TIMESTAMP,
            files_count INTEGER
        )
    """)
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
    os_info: str
    files: List[SyncFile]


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
        INSERT INTO devices (device_id, hostname, os, last_sync, sync_count)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(device_id) DO UPDATE SET
            hostname=excluded.hostname,
            os=excluded.os,
            last_sync=excluded.last_sync,
            sync_count=sync_count + 1
        """,
        (payload.device_id, payload.hostname, payload.os_info, now),
    )

    for item in payload.files:
        rel_path = item.path.replace("\\", "/").strip("/")
        dest_path = os.path.join(STORAGE_DIR, rel_path)
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
def pull_files(device_id: str, hostname: str = "unknown", token: None = Depends(verify_token)):
    files_to_send = []
    for root, _, files in os.walk(STORAGE_DIR):
        for fname in files:
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, STORAGE_DIR).replace("\\", "/")
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
# Dashboard
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
def get_dashboard(auth: None = Depends(verify_auth)):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    devices = cur.execute("SELECT * FROM devices ORDER BY last_sync DESC").fetchall()
    conn.close()

    synced_items = []
    for root, _, files in os.walk(STORAGE_DIR):
        for fname in files:
            p = os.path.join(root, fname)
            rel = os.path.relpath(p, STORAGE_DIR).replace("\\", "/")
            sz = os.path.getsize(p)
            synced_items.append({"path": rel, "size": f"{sz / 1024:.2f} KB"})

    dev_html = "".join(
        f"""
        <tr class="border-b border-zinc-800">
            <td class="p-3 font-medium text-emerald-400">{d['hostname']}</td>
            <td class="p-3 text-zinc-400">{d['os']}</td>
            <td class="p-3 font-mono text-xs text-zinc-500">{d['device_id']}</td>
            <td class="p-3 text-zinc-300">{d['last_sync']} UTC</td>
            <td class="p-3 text-center">{d['sync_count']}</td>
        </tr>
    """
        for d in devices
    )

    items_html = "".join(
        f"""
        <tr class="border-b border-zinc-800 hover:bg-zinc-800/50">
            <td class="p-2 font-mono text-xs text-zinc-200">{i['path']}</td>
            <td class="p-2 font-mono text-xs text-zinc-500 text-right">{i['size']}</td>
        </tr>
    """
        for i in synced_items
    )

    return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Oh My Pi Sync Hub</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-zinc-950 text-zinc-100 min-h-screen p-8">
        <div class="max-w-6xl mx-auto space-y-6">
            <div class="flex justify-between items-center border-b border-zinc-800 pb-4">
                <div>
                    <h1 class="text-2xl font-bold tracking-tight">Oh My Pi Sync Hub</h1>
                    <p class="text-zinc-400 text-sm">Real-time instance synchronizer</p>
                </div>
                <span class="px-3 py-1 bg-emerald-950 text-emerald-400 border border-emerald-800 rounded-full text-xs font-semibold">Active</span>
            </div>

            <!-- Devices Panel -->
            <div class="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
                <h2 class="text-md font-semibold text-zinc-300 mb-3">Connected Instances ({len(devices)})</h2>
                <table class="w-full text-sm text-left">
                    <thead class="text-xs uppercase bg-zinc-800 text-zinc-400">
                        <tr><th class="p-3">Device / Host</th><th class="p-3">OS</th><th class="p-3">ID</th><th class="p-3">Last Synced</th><th class="p-3 text-center">Syncs</th></tr>
                    </thead>
                    <tbody>{dev_html if dev_html else '<tr><td colspan="5" class="p-4 text-center text-zinc-500">No instances registered</td></tr>'}</tbody>
                </table>
            </div>

            <!-- Synced Inventory -->
            <div class="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
                <h2 class="text-md font-semibold text-zinc-300 mb-3">Synced Files & Models ({len(synced_items)})</h2>
                <div class="overflow-y-auto max-h-96">
                    <table class="w-full text-sm text-left">
                        <thead class="text-xs uppercase bg-zinc-800 text-zinc-400">
                            <tr><th class="p-2">Relative Agent Path</th><th class="p-2 text-right">Size</th></tr>
                        </thead>
                        <tbody>{items_html if items_html else '<tr><td colspan="2" class="p-4 text-center text-zinc-500">No synced items found</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </body>
    </html>
    """
