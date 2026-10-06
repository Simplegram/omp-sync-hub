import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// 1. Resolve agent directory & load config
// ---------------------------------------------------------------------------
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
const ENV_PATH = path.join(AGENT_DIR, ".env");
const ENV_SYNCED_PATH = path.join(AGENT_DIR, ".env.synced");

function loadDotEnv(fp: string): Record<string, string> {
  if (!fs.existsSync(fp)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(fp, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

// Load .env.synced first (shared), then .env (local, overrides)
const cfg = { ...loadDotEnv(ENV_SYNCED_PATH), ...loadDotEnv(ENV_PATH) };
const GIT_URL = (cfg.OMP_GIT_URL || process.env.OMP_GIT_URL || "").trim();

// ---------------------------------------------------------------------------
// 2. Git helpers
// ---------------------------------------------------------------------------
function gitSync(args: string): string {
  return execSync(`git ${args}`, {
    cwd: AGENT_DIR,
    stdio: "pipe",
    encoding: "utf8",
  }).trim();
}

async function gitAsync(args: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args}`, { cwd: AGENT_DIR });
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// 3. shellPath: keep machine-specific path out of synced configs
// ---------------------------------------------------------------------------
const SHELLPATH_FILES = ["config.yml", "config.yaml"];

/** Read shellPath from the first config file that has it. */
function extractShellPath(): string | null {
  for (const name of SHELLPATH_FILES) {
    const p = path.join(AGENT_DIR, name);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(/^shellPath:\s*(\S+)/m);
    if (m) return m[1];
  }
  return null;
}

/** Remove shellPath lines from config files so they're never committed. */
function stripShellPath(): void {
  for (const name of SHELLPATH_FILES) {
    const p = path.join(AGENT_DIR, name);
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, "utf8");
    if (!/^shellPath:.*$/m.test(content)) continue;
    fs.writeFileSync(p, content.replace(/^shellPath:.*\r?\n?/m, ""));
  }
}

/** Inject OMP_SHELL_PATH from .env into the first existing config file. */
function injectShellPath(): void {
  const env = loadDotEnv(ENV_PATH);
  const shell = env.OMP_SHELL_PATH || process.env.OMP_SHELL_PATH || "";
  if (!shell) return;
  for (const name of SHELLPATH_FILES) {
    const p = path.join(AGENT_DIR, name);
    if (!fs.existsSync(p)) continue;
    let content = fs.readFileSync(p, "utf8");
    if (/^shellPath:/m.test(content)) {
      content = content.replace(/^shellPath:.*$/m, `shellPath: ${shell}`);
    } else {
      content = content.replace(/\s*$/, `\nshellPath: ${shell}\n`);
    }
    fs.writeFileSync(p, content);
    return;
  }
}

/** One-time migration: move shellPath from config to .env during bootstrap. */
function migrateShellPath(): void {
  const existing = loadDotEnv(ENV_PATH);
  if (existing.OMP_SHELL_PATH) return;
  const shell = extractShellPath();
  if (!shell) return;
  let envContent = fs.readFileSync(ENV_PATH, "utf8");
  envContent = envContent.replace(/\s*$/, `\nOMP_SHELL_PATH=${shell}\n`);
  fs.writeFileSync(ENV_PATH, envContent);
  stripShellPath();
}

// ---------------------------------------------------------------------------
// 4. Bootstrap: .gitignore, git init, remote, author, shellPath migration
// ---------------------------------------------------------------------------
/** Paths (and subtrees) that are synced. Everything else is ignored. */
const SYNC_WHITELIST = [
  ".gitignore",
  ".env.synced",
  "extensions/",
  "skills/",
  "RULES.md",
  "APPEND_SYSTEM.md",
  "config.yml",
  "mcp.json",
  "models.yml",
  "config.yaml",
];


/** Build .gitignore: ignore all, then un-ignore whitelist entries. */
function buildGitIgnore(): string {
  const lines = ["*"];
  for (const p of SYNC_WHITELIST) {
    lines.push(`!${p}`);
    if (p.endsWith("/")) lines.push(`!${p}**`);
  }
  return lines.join("\n") + "\n";
}

/** True if a git-tracked path should stay tracked (matches the whitelist). */
function isWhitelisted(filePath: string): boolean {
  for (const p of SYNC_WHITELIST) {
    if (p.endsWith("/")) {
      if (filePath.startsWith(p)) return true;
    } else if (filePath === p) {
      return true;
    }
  }
  return false;
}
function bootstrap(): void {
  try {
    gitSync("--version");
  } catch {
    throw new Error("[omp-sync] git not found in PATH");
  }

  // Write .gitignore if missing
  const gi = path.join(AGENT_DIR, ".gitignore");
  const newIgnore = buildGitIgnore();
  if (!fs.existsSync(gi) || fs.readFileSync(gi, "utf-8") !== newIgnore) {
    fs.writeFileSync(gi, newIgnore);
  }

  // Migrate shellPath from config to .env (one-time)
  migrateShellPath();

  // Init repo if needed
  try {
    gitSync("rev-parse --is-inside-work-tree");
  } catch {
    gitSync("init -b main");
  }

  // Local author (avoids global git config prompts)
  gitSync('config user.name "omp-sync"');
  gitSync('config user.email "omp-sync@local"');

  // Untrack anything not in the whitelist (prevents old junk from staying tracked)
  const tracked = gitSync("ls-files");
  const toRemove = tracked
    .split("\n")
    .filter((f) => f && !isWhitelisted(f));
  if (toRemove.length > 0) {
    gitSync(`rm --cached -- ${toRemove.map((f) => `"${f}"`).join(" ")}`);
  }
  // Ensure remote
  if (!GIT_URL) return;
  try {
    const cur = gitSync("remote get-url origin");
    if (cur !== GIT_URL) gitSync(`remote set-url origin "${GIT_URL}"`);
  } catch {
    gitSync(`remote add origin "${GIT_URL}"`);
  }
}

/** Returns true if the remote has at least one commit on main. */
async function remoteHasCommits(): Promise<boolean> {
  try {
    return (await gitAsync("ls-remote --heads origin main")).length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 5. Safe pull (rebase + autostash, abort on conflict, inject shellPath)
// ---------------------------------------------------------------------------
function syncPull(): void {
  try {
    gitSync("pull --rebase --autostash origin main");
  } catch {
    try { gitSync("rebase --abort"); } catch { /* ignore */ }
    // Force: adopt remote state, discard local unpushed changes
    gitSync("reset --hard origin/main");
  }
  injectShellPath();
}

async function asyncPull(): Promise<void> {
  try {
    await gitAsync("pull --rebase --autostash origin main");
  } catch {
    try { await gitAsync("rebase --abort"); } catch { /* ignore */ }
    // Force: adopt remote state, discard local unpushed changes
    await gitAsync("reset --hard origin/main");
  }
  injectShellPath();
}

// ---------------------------------------------------------------------------
// 6. Push (strip shellPath, commit, push with fast-forward retry)
// ---------------------------------------------------------------------------
function syncPush(): void {
  stripShellPath();
  gitSync("add -A");
  if (!gitSync("status --porcelain")) return;
  gitSync(`commit -m "sync: ${new Date().toISOString()}"`);
  try {
    gitSync("push origin main");
  } catch {
    syncPull();
    gitSync("push origin main");
  }
}

async function asyncPush(): Promise<void> {
  stripShellPath();
  await gitAsync("add -A");
  const status = await gitAsync("status --porcelain");
  if (!status) return;
  await gitAsync(`commit -m "sync: ${new Date().toISOString()}"`);
  try {
    await gitAsync("push origin main");
  } catch {
    await asyncPull();
    await gitAsync("push origin main");
  }
}

// ---------------------------------------------------------------------------
// 7. Minimal ExtensionAPI interfaces
// ---------------------------------------------------------------------------
interface SyncCommandContext {
  ui?: {
    notify?: (msg: string, level?: string) => void;
    setWorkingMessage?: (msg: string) => void;
  };
}
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

/** Print status: try UI notify, always log to console. */
function status(ctx: SyncCommandContext, msg: string): void {
  console.log(`[omp-sync] ${msg}`);
  ctx.ui?.notify?.(msg);
}
function completions(arg: string): SyncCompletion[] | null {
  const t = (arg || "").trim().toLowerCase();
  if (t.includes(" ")) return null;
  const m = SUBS.filter((s) => s.label.startsWith(t));
  return m.length ? m : null;
}

// ---------------------------------------------------------------------------
// 9. Extension entry point
// ---------------------------------------------------------------------------
export default function (pi: ExtensionLike): void {
  let pushTimer: NodeJS.Timeout | undefined;
  const PUSH_DELAY = 2500;

  // Bootstrap (local-only, fast) – failures are non-fatal
  try {
    bootstrap();
  } catch (e) {
    console.error(`[omp-sync] bootstrap warning: ${e}`);
  }

  // First-machine bootstrap: commit + push if remote is empty
  if (GIT_URL) {
    (async () => {
      if (!await remoteHasCommits()) {
        console.log("[omp-sync] Remote empty – initial push…");
        await asyncPush();
        console.log("[omp-sync] Initial push complete");
      }
    })().catch((e) => console.error(`[omp-sync] initial push failed: ${e}`));
  }

  // --- Lifecycle hooks ---

  pi.on("session_start", () => {
    if (!GIT_URL) return;
    asyncPull().catch(() => { /* non-blocking; next turn will retry */ });
  });

  pi.on("turn_end", () => {
    if (!GIT_URL) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      asyncPush().catch((e) => console.error(`[omp-sync] push failed: ${e}`));
    }, PUSH_DELAY);
  });

  pi.on("session_shutdown", () => {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = undefined; }
    if (!GIT_URL) return;
    asyncPush().catch(() => { /* best effort */ });
  });

  // --- /sync command ---

  pi.registerCommand("sync", {
    description: "Git sync: /sync [push|pull|status|test]",
    getArgumentCompletions: completions,
    handler: async (args: string, ctx: SyncCommandContext) => {
      if (!GIT_URL) {
        status(ctx, "Not configured. Set OMP_GIT_URL in .env");
        return;
      }
      const cmd = (args.trim().split(/\s+/)[0] || "").toLowerCase();

      try {
        switch (cmd) {
          case "push":
            status(ctx, "Pushing…");
            await asyncPush();
            status(ctx, "Push complete");
            break;
          case "pull":
            status(ctx, "Pulling…");
            await asyncPull();
            status(ctx, "Pull complete");
            break;
          case "status": {
            const st = await gitAsync("status --short");
            const recent = await gitAsync("log --oneline -5");
            status(ctx, `Status:\n${st || "(clean)"}\n\nRecent:\n${recent}`);
            break;
          }
          case "test":
            await gitAsync("ls-remote --get-url origin");
            status(ctx, `Remote OK: ${GIT_URL}`);
            break;
          default:
            status(
              ctx,
              "Usage:\n" +
                "  /sync push     Commit & push to remote\n" +
                "  /sync pull     Pull from remote\n" +
                "  /sync status   Show git status + recent commits\n" +
                "  /sync test     Verify remote connectivity"
            );
        }
      } catch (e: unknown) {
        status(ctx, `Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
}
