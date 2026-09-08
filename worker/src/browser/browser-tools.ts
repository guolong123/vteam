import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export const BROWSER_TOOLS_REL_DIR = path.join('.opencode', 'tools');
export const BROWSER_TOOL_FILE = 'browser.ts';

/**
 * Per-agent browser isolation (option A).
 *
 * Pinned CLI: agent-browser 0.27.0 (worker Dockerfile `npm i -g agent-browser`;
 * version string + full `--help` captured under
 * .omo/evidence/browser-isolation/). Empirically supported isolation
 * primitives in THIS version:
 * - `--session <name>` (global option, also AGENT_BROWSER_SESSION): isolated
 *   browser with its own daemon socket (~/.agent-browser/<name>.sock), tabs,
 *   refs, cookies and storage. Proven parallel-safe: two concurrent
 *   `--session` opens succeed with separate daemons (no global lock).
 * - `--profile <name|path>` (also AGENT_BROWSER_PROFILE): Chrome user-data-dir;
 *   a directory path creates a real profile there (Default/, Local State,
 *   DevToolsActivePort singleton lock lives INSIDE the dir, so separate paths
 *   = no lock contention, no shared cookie jar).
 * - `close --session <name>` closes ONE session; `close --all` kills every
 *   session (forbidden in the shim).
 * There is NO `--context` flag in 0.27.0 (do not assume it exists).
 *
 * Scope derivation (host + shim share the same rules; shim inlines its own
 * copy because it runs inside the opencode tool sandbox):
 * 1. opencode ToolContext.sessionID (== ExecuteRequestPayload.sessionId, the
 *    ses_* id) sanitized → primary scope. No global mutable current-session:
 *    identity arrives per tool call via the context argument.
 * 2. Fallback when sessionID absent: stable `member-<hash8>` derived from
 *    ToolContext.directory + ToolContext.agent (task/member-scoped, same agent
 *    re-attaches to ITS scope, never another's).
 * 3. Last resort: "default".
 *
 * Daemon lifecycle (chosen strategy + why): per-scope daemons are created
 * on first use and owned by the CLI (one Chrome per scope); we do NOT add a
 * mutex/queue (empirically unnecessary — parallel opens succeed) and we do
 * NOT add a global single lock (that would defeat option A). Profiles under
 * <workDir>/browser-profiles/<scope>/ are RETAINED (login persistence is the
 * point; volume-persisted, disk-cheap); explicit teardown is the agent's own
 * scoped `close` (injected `--session` makes bare `close` scoped); `close
 * --all` is rejected in-shim. Ops prune: rm -rf idle scope dirs as needed.
 */
export const BROWSER_PROFILE_SUBDIR = 'browser-profiles';

/** Last-resort scope when neither sessionID nor directory/agent is available. */
export const BROWSER_DEFAULT_SCOPE = 'default';

/** Scope ids are used as CLI args + dir names: keep [A-Za-z0-9_-], max 64. */
export function sanitizeBrowserScopeId(raw: string | undefined | null): string {
  const cleaned = String(raw ?? '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 64);
}

/** Tiny dependency-free hash (mirrored inside the shim template). */
export function hashBrowserScopeSeed(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface BrowserScopeInput {
  sessionId?: string | null;
  directory?: string | null;
  agent?: string | null;
}

/**
 * Resolve the isolation scope for one execution: sanitized opencode ses_* id,
 * else stable member-scoped `member-<hash8(directory|agent)>`, else "default".
 */
export function resolveBrowserScopeId(input: BrowserScopeInput): string {
  const fromSession = sanitizeBrowserScopeId(input.sessionId ?? undefined);
  if (fromSession) return fromSession;
  const dir = String(input.directory ?? '');
  const agent = String(input.agent ?? '');
  if (dir || agent) return `member-${hashBrowserScopeSeed(`${dir}|${agent}`)}`;
  return BROWSER_DEFAULT_SCOPE;
}

/** Per-scope Chrome user-data-dir: <root>/browser-profiles/<scopeId>/. */
export function resolveBrowserProfileDir(root: string, scopeId: string): string {
  return path.join(root, BROWSER_PROFILE_SUBDIR, scopeId);
}

/**
 * Create the scope profile dir on use (best-effort; never throws — the shim
 * re-ensures it at runtime, so a failure here must not block execution).
 */
export function ensureBrowserProfileDir(root: string, scopeId: string): string | null {
  try {
    const dir = resolveBrowserProfileDir(root, scopeId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

export interface BrowserToolDef {
  name: string;
  exportName: string;
  description: string;
  args: { name: string; type: string; required: boolean; description: string }[];
  hint: string;
}

export const BROWSER_TOOLS: readonly BrowserToolDef[] = [
  {
    name: 'browser',
    exportName: 'default',
    description: 'Browser automation via agent-browser (Vercel). Run any agent-browser command: open/snapshot/click/fill/type/press/screenshot/pdf/eval/wait/get/tab/etc. Example: cmd="open https://example.com" or cmd="snapshot -i" or cmd="click @e1". Requires worker container with agent-browser + Chrome.',
    args: [
      { name: 'cmd', type: 'string', required: true, description: 'agent-browser CLI args WITHOUT leading `agent-browser` (e.g. "open https://example.com", "snapshot -i", "click @e1", "screenshot /tmp/page.png")' },
    ],
    hint: 'agent-browser <cmd>',
  },
];

export function isAgentBrowserAvailable(): boolean {
  try {
    const r = spawnSync('agent-browser', ['--version'], { encoding: 'utf8', timeout: 3000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function renderBrowserToolsFile(): string {
  return `/**
 * Browser automation tools (agent-browser) — auto-injected by worker.
 * Tool: browser (default export) -> tool name = "browser"
 * Usage from agent: call browser({cmd: "open https://example.com"})
 * Then snapshot, click via refs, screenshot, eval, etc.
 * Requires container with agent-browser + Chrome (node:22-bookworm-slim).
 *
 * Per-agent isolation (option A, agent-browser 0.27.0): every call is scoped
 * to THIS opencode session via --session <scope> + --profile <user-data-dir>.
 * Scope = ToolContext.sessionID (the ses_* id), else member-<hash8> fallback
 * from directory+agent. Never pass "close --all" (rejected below).
 */
import { tool } from "@opencode-ai/plugin";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

function sanitizeScope(raw: unknown): string {
  const cleaned = String(raw ?? "").replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 64);
}

function hashSeed(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function resolveScope(ctx: any): string {
  const fromSession = sanitizeScope(ctx?.sessionID);
  if (fromSession) return fromSession;
  const dir = typeof ctx?.directory === "string" ? ctx.directory : "";
  const agent = typeof ctx?.agent === "string" ? ctx.agent : "";
  if (dir || agent) return "member-" + hashSeed(dir + "|" + agent);
  return ${JSON.stringify(BROWSER_DEFAULT_SCOPE)};
}

export default tool({
  description: ${JSON.stringify(BROWSER_TOOLS[0].description)},
  args: {
    cmd: tool.schema.string().describe(${JSON.stringify(BROWSER_TOOLS[0].args[0].description)}),
  },
  async execute(args: any, context: any) {
    const scope = resolveScope(context);
    const profileRoot = process.env.WORK_DIR || process.cwd();
    const profileDir = join(profileRoot, ${JSON.stringify(BROWSER_PROFILE_SUBDIR)}, scope);
    try { mkdirSync(profileDir, { recursive: true }); } catch {}
    const raw = String(args?.cmd ?? "").trim();
    if (!raw) throw new Error("browser: cmd is required (e.g. \\"open https://example.com\\")");
    // naive shell-like split respecting double quotes (good enough for agent use)
    const parts: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === " " && !inQuote) { if (cur) { parts.push(cur); cur = ""; } continue; }
      cur += ch;
    }
    if (cur) parts.push(cur);
    if (parts[0] === "close" && parts.includes("--all")) {
      throw new Error("browser: 'close --all' is forbidden in the shared worker (it would kill other agents' browsers); plain 'close' closes only your own isolated session");
    }
    const scoped: string[] = [];
    if (!parts.includes("--session")) scoped.push("--session", scope);
    if (!parts.includes("--profile")) scoped.push("--profile", profileDir);
    const finalArgs = [...scoped, ...parts];
    const result = spawnSync("agent-browser", finalArgs, { encoding: "utf8", timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    const out = (result.stdout ?? "") + (result.stderr ?? "");
    if (result.status !== 0) {
      throw new Error(out.trim() || \`agent-browser \${raw} failed (exit \${result.status})\`);
    }
    return out.trim() || "(no output)";
  },
});
`;
}

export function installBrowserTools(workDir: string): string | null {
  if (!isAgentBrowserAvailable()) {
    return null;
  }
  const toolsDir = path.join(workDir, BROWSER_TOOLS_REL_DIR);
  fs.mkdirSync(toolsDir, { recursive: true });
  const filePath = path.join(toolsDir, BROWSER_TOOL_FILE);
  fs.writeFileSync(filePath, renderBrowserToolsFile(), 'utf8');
  return filePath;
}
