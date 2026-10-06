import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// 1. Resolve agent directory
// ---------------------------------------------------------------------------
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
const ENV_PATH = path.join(AGENT_DIR, ".env");

// ---------------------------------------------------------------------------
// 2. Zero-dependency .env parser
// ---------------------------------------------------------------------------
function loadDotEnv(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return result;
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
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
const USERNAME = process.env.USERNAME || os.hostname();

// ---------------------------------------------------------------------------
// 3. File groups
// ---------------------------------------------------------------------------
/** Groups that are safe to pull by default (no machine-specific paths). */
const SAFE_GROUPS = ["config", "skills", "extensions"];

/** All groups that can be explicitly pulled. */
const ALL_GROUPS = ["config", "skills", "extensions", "sessions", "memories"];

const TARGET_DIRECTORIES = ["skills", "extensions", "sessions", "memories"];
const BASE_FILES = [
  "config.yml",
  "config.yaml",
  "models.yml",
  "models.db",
  "memory_summary.md",
];

if (SYNC_AUTH_DB) {
  BASE_FILES.push("agent.db");
}

// ---------------------------------------------------------------------------
// 4. File collection
// ---------------------------------------------------------------------------
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
      if (!rel.includes("omp-sync.ts") && !rel.endsWith(".env")) {
        results.push(rel);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 5. Progress logger
// ---------------------------------------------------------------------------
type ProgressFn = (msg: string) => void;

function makeProgress(
  label: string,
  total: number,
  log: ProgressFn,
): (filePath: string, idx: number) => void {
  return (filePath: string, idx: number) => {
    log(`[Sync] ${label}: ${idx}/${total} ${filePath}`);
  };
}

// ---------------------------------------------------------------------------
// 6. Sync operations
// ---------------------------------------------------------------------------
async function pushSync(
  log?: ProgressFn,
): Promise<number> {
  if (!SERVER_URL || !SYNC_SECRET) return 0;

  const fileEntries: Array<{ path: string; content: string; mtime: number }> = [];

  for (const file of BASE_FILES) {
    const filePath = path.join(AGENT_DIR, file);
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath).toString("base64");
      fileEntries.push({ path: file, content, mtime: stat.mtimeMs });
    }
  }

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

  const total = fileEntries.length;
  const progress = log ? makeProgress("push", total, log) : undefined;

  for (let i = 0; i < total; i++) {
    progress?.(fileEntries[i].path, i + 1);
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
      username: USERNAME,
      os_info: `Windows (${os.release()})`,
      files: fileEntries,
    }),
  });

  if (!res.ok) throw new Error(`Push failed HTTP ${res.status}`);
  return total;
}

/**
 * Pull files from the server.
 * @param groups – optional list of groups to pull. Defaults to SAFE_GROUPS.
 */
async function pullSync(
  groups?: string[],
  log?: ProgressFn,
): Promise<number> {
  if (!SERVER_URL || !SYNC_SECRET) return 0;

  const groupList = groups && groups.length > 0 ? groups : SAFE_GROUPS;

  const url =
    `${SERVER_URL}/api/sync/pull` +
    `?device_id=${encodeURIComponent(DEVICE_ID)}` +
    `&hostname=${encodeURIComponent(HOSTNAME)}` +
    `&groups=${encodeURIComponent(groupList.join(","))}`;

  const res = await fetch(url, {
    headers: { "x-sync-token": SYNC_SECRET },
  });

  if (!res.ok) throw new Error(`Pull failed HTTP ${res.status}`);
  const data: { files: Array<{ path: string; content: string; mtime: number }> } =
    await res.json();

  const files = data.files.filter(
    (f) => !f.path.includes("omp-sync.ts") && f.path !== ".env",
  );
  const total = files.length;
  const progress = log ? makeProgress("pull", total, log) : undefined;

  let count = 0;
  for (let i = 0; i < total; i++) {
    const item = files[i];
    const dest = path.join(AGENT_DIR, item.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buffer = Buffer.from(item.content, "base64");
    fs.writeFileSync(dest, buffer);
    count++;
    progress?.(item.path, i + 1);
  }
  return count;
}

/** Fetch the list of available groups and file counts from the server. */
async function fetchAvailableGroups(): Promise<
  Array<{ name: string; files: number }>
> {
  if (!SERVER_URL || !SYNC_SECRET) return [];

  const url = `${SERVER_URL}/api/sync/available`;

  const res = await fetch(url, {
    headers: { "x-sync-token": SYNC_SECRET },
  });

  if (!res.ok) throw new Error(`Available check failed HTTP ${res.status}`);
  const data: { groups: Array<{ name: string; files: number }> } =
    await res.json();
  return data.groups;
}

async function testConnection(): Promise<string> {
  if (!SERVER_URL || !SYNC_SECRET)
    return "Not configured (missing OMP_SYNC_URL or OMP_SYNC_SECRET)";

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
// 7. Minimal ExtensionAPI interface (zero-dependency single-file extension)
// ---------------------------------------------------------------------------
interface SyncUi {
  notify?: (msg: string, level?: string) => void;
  setWorkingMessage?: (msg: string) => void;
}

interface SyncCommandContext {
  ui?: SyncUi;
}

type TimerHandle = NodeJS.Timeout;

interface SyncCompletion {
  label: string;
  value: string;
  description?: string;
}

interface ExtensionLike {
  on: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => void;
  registerCommand: (
    name: string,
    def: {
      description?: string;
      handler: (args: string, ctx: SyncCommandContext) => void | Promise<void>;
      getArgumentCompletions?: (arg: string) => SyncCompletion[] | null;
    },
  ) => void;
}

// ---------------------------------------------------------------------------
// 8. Tab-completion candidates
// ---------------------------------------------------------------------------
const SUB_COMMANDS: SyncCompletion[] = [
  { label: "push", value: "push", description: "Push all files to server" },
  { label: "pull", value: "pull", description: "Pull safe groups (config, skills, extensions)" },
  { label: "pull all", value: "pull all", description: "Pull everything including sessions, memories" },
  { label: "select", value: "select", description: "List available groups on server" },
  { label: "test", value: "test", description: "Test server connection" },
];

function getSyncCompletions(arg: string): SyncCompletion[] | null {
  const text = (arg || "").trim().toLowerCase();

  // Second-level: /sync pull <group>
  const pullMatch = text.match(/^pull[ \t]+(\S*)$/);
  if (pullMatch) {
    const prefix = pullMatch[1].toLowerCase();
    const groupOptions: SyncCompletion[] = [
      { label: "all", value: "pull all", description: "All groups" },
      ...ALL_GROUPS.map((g) => ({
        label: g,
        value: `pull ${g}`,
        description: `Pull ${g} group`,
      })),
    ];
    const filtered = groupOptions.filter(
      (o) => o.label.startsWith(prefix) || o.value.startsWith(`pull ${prefix}`),
    );
    return filtered.length ? filtered : null;
  }

  // First-level: /sync <subcommand>
  if (text.includes(" ")) return null;
  const m = SUB_COMMANDS.filter((s) => s.label.startsWith(text));
  return m.length ? m : null;
}

// ---------------------------------------------------------------------------
// 9. Debounce state (module-level; cleared on session_shutdown)
// ---------------------------------------------------------------------------
let debounceTimer: TimerHandle | undefined;

// ---------------------------------------------------------------------------
// 10. Extension entry point
// ---------------------------------------------------------------------------
export default function (pi: ExtensionLike): void {
  pi.on("session_start", async () => {
    if (!SERVER_URL || !SYNC_SECRET) return;
    try {
      await pullSync();
    } catch {
      // server may not have initial bundle yet
    }
  });

  pi.on("turn_end", () => {
    if (!SERVER_URL || !SYNC_SECRET) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        await pushSync();
      } catch {
        // silent on background auto-sync
      }
    }, 2500);
  });

  pi.on("session_shutdown", async () => {
    clearTimeout(debounceTimer);
    if (!SERVER_URL || !SYNC_SECRET) return;
    try {
      await pushSync();
    } catch {
      // exit gracefully
    }
  });

  pi.registerCommand("sync", {
    description: "Sync with hub: /sync [push|pull|select|test] [groups...]",
    getArgumentCompletions: getSyncCompletions,
    handler: async (args: string, ctx: SyncCommandContext) => {
      if (!SERVER_URL || !SYNC_SECRET) {
        ctx.ui?.notify?.("[Sync Hub] Not configured. Create .env in your agent directory.");
        return;
      }

      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const cmd = (parts[0] || "").toLowerCase();

      const log: ProgressFn = (msg: string) => {
        ctx.ui?.setWorkingMessage?.(msg);
      };

      try {
        if (cmd === "push") {
          ctx.ui?.setWorkingMessage?.("[Sync] Pushing...");
          const c = await pushSync(log);
          ctx.ui?.notify?.(`[Sync Hub] Pushed ${c} items to server.`);
        } else if (cmd === "pull") {
          const groupArg = (parts[1] || "").toLowerCase();
          let groups: string[] | undefined;
          if (groupArg === "all") {
            groups = ALL_GROUPS;
          } else if (groupArg) {
            groups = groupArg.split(",").map((g) => g.trim()).filter(Boolean);
          }
          ctx.ui?.setWorkingMessage?.("[Sync] Pulling...");
          const c = await pullSync(groups, log);
          const label = groups
            ? groups.join(", ")
            : SAFE_GROUPS.join(", ");
          ctx.ui?.notify?.(`[Sync Hub] Pulled ${c} items (groups: ${label}).`);
        } else if (cmd === "select") {
          const available = await fetchAvailableGroups();
          if (available.length === 0) {
            ctx.ui?.notify?.("[Sync Hub] No groups found on server. Push first.");
          } else {
            const lines = available.map((g) => {
              const safe = SAFE_GROUPS.includes(g.name) ? " (default)" : "";
              return `  ${g.name} — ${g.files} files${safe}`;
            });
            ctx.ui?.notify?.(
              `[Sync Hub] Available groups:\n` +
                lines.join("\n") +
                `\n\nPull with: /sync pull <group1,group2,...>` +
                `\nAll: /sync pull all`
            );
          }
        } else if (cmd === "test") {
          const result = await testConnection();
          ctx.ui?.notify?.(`[Sync Hub] ${result}`);
        } else {
          ctx.ui?.notify?.(
            "[Sync Hub] Usage:\n" +
              "  /sync push              Push all files to server\n" +
              "  /sync pull              Pull safe groups (config, skills, extensions)\n" +
              "  /sync pull all          Pull everything including sessions, memories\n" +
              "  /sync pull sessions     Pull specific groups (comma-separated)\n" +
              "  /sync select            List available groups on server\n" +
              "  /sync test              Test server connection"
          );
        }
      } catch (err: unknown) {
        ctx.ui?.notify?.(`[Sync Hub Error] ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
