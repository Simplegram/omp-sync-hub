import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// 1. Resolve agent directory
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
const ENV_PATH = path.join(AGENT_DIR, ".env");

// 2. Zero-dependency .env parser
function loadDotEnv(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return result;

  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  return result;
}

const config = loadDotEnv(ENV_PATH);

const SERVER_URL = (config.OMP_SYNC_URL || process.env.OMP_SYNC_URL || "").replace(/\/+$/, "");
const SYNC_SECRET = config.OMP_SYNC_SECRET || process.env.OMP_SYNC_SECRET || "";
const SYNC_AUTH_DB = (config.SYNC_AUTH_DB || "true").toLowerCase() === "true";

const DEVICE_ID = crypto
  .createHash("sha256")
  .update(os.hostname())
  .digest("hex")
  .slice(0, 10);
const HOSTNAME = os.hostname();

const TARGET_DIRECTORIES = ["skills", "extensions", "sessions", "memories"];
const BASE_FILES = [
  "config.yml",
  "config.yaml",
  "models.yml",
  "memory_summary.md",
];

if (SYNC_AUTH_DB) {
  BASE_FILES.push("agent.db");
}

function getRelativeFiles(dir: string, baseDir = dir): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(getRelativeFiles(full, baseDir));
    } else {
      const rel = path.relative(baseDir, full);
      // Skip the sync extension itself and local .env file
      if (!rel.includes("omp-sync.ts") && !rel.endsWith(".env")) {
        results.push(rel);
      }
    }
  }
  return results;
}

async function pushSync(): Promise<number> {
  if (!SERVER_URL || !SYNC_SECRET) return 0;

  const fileEntries: Array<{ path: string; content: string; mtime: number }> = [];

  // Collect individual files
  for (const file of BASE_FILES) {
    const filePath = path.join(AGENT_DIR, file);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath).toString("base64");
      fileEntries.push({ path: file, content, mtime: stat.mtimeMs });
    }
  }

  // Collect directories recursively
  for (const folder of TARGET_DIRECTORIES) {
    const folderPath = path.join(AGENT_DIR, folder);
    if (fs.existsSync(folderPath)) {
      const relFiles = getRelativeFiles(folderPath, AGENT_DIR);
      for (const rel of relFiles) {
        const full = path.join(AGENT_DIR, rel);
        const stat = fs.statSync(full);
        const content = fs.readFileSync(full).toString("base64");
        fileEntries.push({ path: rel, content, mtime: stat.mtimeMs });
      }
    }
  }

  const res = await fetch(`${SERVER_URL}/api/sync/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sync-token": SYNC_SECRET,
    },
    body: JSON.stringify({
      device_id: DEVICE_ID,
      hostname: HOSTNAME,
      os_info: `Windows (${os.release()})`,
      files: fileEntries,
    }),
  });

  if (!res.ok) throw new Error(`Push failed HTTP ${res.status}`);
  return fileEntries.length;
}

async function pullSync(): Promise<number> {
  if (!SERVER_URL || !SYNC_SECRET) return 0;

  const url = `${SERVER_URL}/api/sync/pull?device_id=${DEVICE_ID}&hostname=${encodeURIComponent(HOSTNAME)}`;
  const res = await fetch(url, {
    headers: { "x-sync-token": SYNC_SECRET },
  });

  if (!res.ok) throw new Error(`Pull failed HTTP ${res.status}`);
  const data: { files: Array<{ path: string; content: string; mtime: number }> } =
    await res.json();

  let count = 0;
  for (const item of data.files) {
    // Never overwrite the sync extension or the device's local .env file
    if (item.path.includes("omp-sync.ts") || item.path === ".env") continue;

    const dest = path.join(AGENT_DIR, item.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const buffer = Buffer.from(item.content, "base64");
    fs.writeFileSync(dest, buffer);
    count++;
  }
  return count;
}

async function testConnection(): Promise<string> {
  if (!SERVER_URL || !SYNC_SECRET) return "Not configured (missing OMP_SYNC_URL or OMP_SYNC_SECRET)";

  const controller = AbortSignal.timeout(5000);
  const res = await fetch(`${SERVER_URL}/api/health`, {
    headers: { "x-sync-token": SYNC_SECRET },
    signal: controller,
  });

  if (!res.ok) return `Server responded HTTP ${res.status}`;

  const data: { status: string } = await res.json();
  return `Connected to ${SERVER_URL} (${data.status})`;
}

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------
interface OmpUi {
  setWorkingMessage?: (msg: string) => void;
  notify?: (msg: string) => void;
}

interface CommandContext {
  ui?: OmpUi;
}

interface OmpApi {
  on?: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => void;
  registerCommand?: (name: string, handler: (args: string, ctx: CommandContext) => Promise<void>) => void;
}

// ---------------------------------------------------------------------------
// Shared state (module-level so both activate and handler see the same timer)
// ---------------------------------------------------------------------------
let debounceTimer: NodeJS.Timeout | undefined = undefined;

const triggerDebouncedPush = () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    try {
      await pushSync();
    } catch {
      // silent on background auto-sync
    }
  }, 2500);
};

// ---------------------------------------------------------------------------
// Extension entry point – factory function
// ---------------------------------------------------------------------------
export default function (omp: OmpApi) {
  if (SERVER_URL && SYNC_SECRET) {
    omp.on?.("session_start", async () => {
      try {
        await pullSync();
      } catch {
        // server may not have initial bundle yet
      }
    });

    omp.on?.("turn_end", () => {
      triggerDebouncedPush();
    });

    omp.on?.("session_shutdown", async () => {
      try {
        await pushSync();
      } catch {
        // exit gracefully
      }
    });
  }

  const syncHandler = async (args: string, ctx: CommandContext): Promise<void> => {
    if (!SERVER_URL || !SYNC_SECRET) {
      ctx?.ui?.notify?.("[Sync Hub] Not configured. Create .env in your agent directory.");
      return;
    }
    ctx?.ui?.setWorkingMessage?.("Syncing with hub...");
    try {
      const cmd = args.trim().toLowerCase();
      if (cmd === "push") {
        const c = await pushSync();
        ctx?.ui?.notify?.(`[Sync Hub] Pushed ${c} items to server.`);
      } else if (cmd === "pull") {
        const c = await pullSync();
        ctx?.ui?.notify?.(`[Sync Hub] Pulled ${c} items from server.`);
      } else if (cmd === "test") {
        const result = await testConnection();
        ctx?.ui?.notify?.(`[Sync Hub] ${result}`);
      } else {
        ctx?.ui?.notify?.("[Sync Hub] Usage: /sync [push|pull|test]");
      }
    } catch (err: unknown) {
      ctx?.ui?.notify?.(`[Sync Hub Error] ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const syncComplete = (prefix: string): string[] => {
    const options = ["push", "pull", "test"];
    const trimmed = prefix.trim().toLowerCase();
    if (!trimmed) return options;
    return options.filter((o) => o.startsWith(trimmed));
  };

  // Register /sync command with the TUI
  omp.registerCommand?.("sync", syncHandler);

  return {
    handler: syncHandler,
    complete: syncComplete,
  };
}
