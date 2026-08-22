import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export const BROWSER_TOOLS_REL_DIR = path.join('.opencode', 'tools');
export const BROWSER_TOOL_FILE = 'browser.ts';

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
 */
import { tool } from "@opencode-ai/plugin";
import { spawnSync } from "node:child_process";

export default tool({
  description: ${JSON.stringify(BROWSER_TOOLS[0].description)},
  args: {
    cmd: tool.schema.string().describe(${JSON.stringify(BROWSER_TOOLS[0].args[0].description)}),
  },
  async execute(args) {
    const raw = String((args as any).cmd ?? "").trim();
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
    const result = spawnSync("agent-browser", parts, { encoding: "utf8", timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
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
