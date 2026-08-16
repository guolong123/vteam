/**
 * T8c MCP 三态探测器：周期执行 `opencode mcp list --pure` 解析各服务器可用性
 * （needs_auth / connected / failed，11 篇 §5.8），随心跳上报控制面。
 *
 * - parseMcpListOutput：剥 ANSI 后逐行解析 `●  ✓ <name> connected` /
 *   `●  ✗ <name> failed` / `<name> needs auth`（OAuth 未授权），失败行附错误文本
 * - McpStatusProbe：**30-60s 节流**（Metis 高优补项 7：不能每 10s 心跳 spawn
 *   子进程）——节流窗口内返回上次探测缓存，窗口外才重新 spawnSync；
 *   探测失败保留上次结果（首次失败返回空数组，由心跳一并上报）
 *
 * worker 独立进程铁律：不 import server 代码；spawnSync 阻塞式（探测在心跳线程，
 * 非高频路径，节流后成本可忽略）。本轮只探测状态，不做 OAuth auth 流程
 * （11 §5.8：OAuth 由 worker 本地完成，控制面仅展示 needs_auth 引导）。
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** MCP 服务器可用性三态（11 §5.8）。 */
export type McpStatus = 'connected' | 'failed' | 'needs_auth';

/** 单台 MCP 服务器的状态上报条目（serverName 与 mcp_servers.name 对应）。 */
export interface McpStatusEntry {
  serverName: string;
  status: McpStatus;
}

/**
 * 内置 vteam MCP 的注入名（新名 `vteam`；存量部署旧名 `keta-platform`，
 * 改名迁移见 server/prisma/seed.ts）。探测失败时对两者都做集群内地址判定。
 */
export const BUILTIN_MCP_SERVERS = ['vteam', 'keta-platform'] as const;

/**
 * 判定内置 MCP 地址是否为集群内服务名（compose 的 `server` / k8s 的 `vteam-server`）。
 * 集群外 worker 无法解析这类地址，是「内置 MCP 不可达」的典型根因。
 */
export function isClusterInternalUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return hostname === 'server' || hostname === 'vteam-server';
}

/** 探测执行函数形态（测试可注入 mock；默认 spawnSync opencode）。 */
export interface McpListProbeFn {
  (): { stdout: string; stderr: string };
}

export interface McpStatusProbeOptions {
  /** 探测节流间隔 ms（默认 30_000，Metis 高优补项 7：30-60s 节流）。 */
  throttleMs?: number;
  /** spawnSync 超时 ms（默认 15_000）。 */
  timeoutMs?: number;
  /**
   * opencode 工作目录（`opencode mcp list` 基于 cwd 逐级查找 opencode.json，
   * 注入的 mcp 配置落在 <workDir>/opencode.json → 探测必须用同一 cwd）。
   */
  cwd?: string;
  /** 探测函数（测试注入）；默认 `opencode mcp list --pure`。 */
  probeFn?: McpListProbeFn;
  /** 日志（可选，默认 console）。 */
  logger?: { warn(message: string): void };
  /**
   * 内置 vteam MCP 配置 URL 解析器（默认读 <cwd>/opencode.json 的 `mcp.<serverName>.url`）。
   * 探测到内置 MCP failed 时用它取实际注入地址，判定集群内服务名后输出 WORKER_MCP_URL 引导。
   */
  resolveBuiltinMcpUrl?: (serverName: string) => string | undefined;
}

/** ANSI 转义序列（剥色/样式）。 */
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** 剥除 ANSI 转义序列（opencode 输出带 [90m 等灰色着色）。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * 解析 `opencode mcp list --pure` 输出为三态条目数组。
 * 剥 ANSI 后逐行匹配 `●  ✓ <name> <状态词>`（✓=成功；✗/! 行按 failed 兜底）：
 * - 状态词含 needs auth / unauthorized → needs_auth（OAuth 未授权）
 * - 状态词含 fail/error/disconnected 或标记为 ✗/! → failed
 * - 其余 → connected
 * 与 11 §5.8 三态对齐；无法解析的行（标题/分隔/命令详情）跳过。
 */
export function parseMcpListOutput(output: string): McpStatusEntry[] {
  const entries: McpStatusEntry[] = [];
  const lines = stripAnsi(output).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    // 状态行：可选列表符号（●/•/*）+ 状态标记 + 服务器名（无空格）+ 状态文本。
    // 标记：✓=connected / ✗=failed / ⚠=needs_auth（实测行 `●  ⚠ <name> needs authentication`）；
    // ASCII 环境（无 Unicode）opencode 用 v=成功 / x=失败 标记，一并兼容。
    const match = trimmed.match(
      /^[●•*]?\s*([✓✗!xXvV⚠])\s+([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s+(.+)$/,
    );
    if (!match) {
      continue;
    }
    const [, mark, name, rest] = match;
    const statusText = rest.trim().toLowerCase();
    let status: McpStatus;
    if (/(needs\s+auth|needs_auth|unauthori[sz]ed|auth\s+required)/.test(statusText)) {
      status = 'needs_auth';
    } else if (
      /fail|error|disconnected|refus|timeout/.test(statusText) ||
      /[✗!xX]/.test(mark)
    ) {
      status = 'failed';
    } else {
      status = 'connected';
    }
    entries.push({ serverName: name, status });
  }
  return entries;
}

/**
 * T8c MCP 三态探测器（带节流缓存）。
 * getStatus() 为同步调用（spawnSync），由心跳定时器驱动：距上次探测 < throttleMs
 * 返回缓存，否则重新执行 `opencode mcp list --pure` 并更新缓存。默认 30s 节流
 * ——10s 心跳周期内最多每 3 次心跳 spawn 一次子进程。
 */
export class McpStatusProbe {
  private readonly throttleMs: number;
  private readonly timeoutMs: number;
  private readonly probeFn: McpListProbeFn;
  private readonly logger?: { warn(message: string): void };
  private readonly resolveBuiltinMcpUrl: (serverName: string) => string | undefined;
  private cached: McpStatusEntry[] = [];
  private lastProbeAt = 0;

  constructor(options: McpStatusProbeOptions = {}) {
    this.throttleMs = options.throttleMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.probeFn =
      options.probeFn ??
      (() => {
        const result = spawnSync('opencode', ['mcp', 'list', '--pure'], {
          encoding: 'utf8',
          timeout: this.timeoutMs,
          ...(options.cwd ? { cwd: options.cwd } : {}),
        });
        return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      });
    this.logger = options.logger;
    this.resolveBuiltinMcpUrl =
      options.resolveBuiltinMcpUrl ?? ((serverName: string) => this.readInjectedUrl(options.cwd, serverName));
  }

  /** 默认 URL 解析：从注入后的 <cwd>/opencode.json 读 `mcp.<name>.url`（探测的同一文件）。 */
  private readInjectedUrl(cwd: string | undefined, serverName: string): string | undefined {
    if (!cwd) {
      return undefined;
    }
    try {
      const config = JSON.parse(
        fs.readFileSync(path.join(cwd, 'opencode.json'), 'utf8'),
      ) as { mcp?: Record<string, { url?: string }> };
      return config?.mcp?.[serverName]?.url;
    } catch {
      return undefined;
    }
  }

  /** 内置 vteam MCP failed 且地址为集群内服务名时输出 WORKER_MCP_URL 引导（仅新探测路径，节流不重复）。 */
  private warnBuiltinUnreachable(entries: McpStatusEntry[]): void {
    const failed = entries.find(
      (e) =>
        BUILTIN_MCP_SERVERS.some((name) => e.serverName === name) && e.status === 'failed',
    );
    if (!failed) {
      return;
    }
    const url = this.resolveBuiltinMcpUrl(failed.serverName);
    if (!url || !isClusterInternalUrl(url)) {
      return;
    }
    this.logger?.warn?.(
      `[mcp-status] 内置 MCP 不可达：地址 ${url} 为集群内服务名，集群外 worker 请设置 WORKER_MCP_URL=<外部可达地址>（如 http://<控制面外部地址>/api/v1/platform-mcp）`,
    );
  }

  /**
   * 当前 MCP 三态快照（节流缓存）。
   * 窗口外重新探测：成功替换缓存；失败（spawn 抛错/非零退出且无解析结果）
   * 保留上次缓存并告警——探测异常不应中断心跳链路。
   */
  getStatus(): McpStatusEntry[] {
    const now = Date.now();
    if (now - this.lastProbeAt < this.throttleMs) {
      return this.cached;
    }
    this.lastProbeAt = now;
    try {
      const { stdout, stderr } = this.probeFn();
      const entries = parseMcpListOutput(stdout);
      if (entries.length > 0 || !stderr) {
        this.cached = entries;
        this.warnBuiltinUnreachable(entries);
      }
    } catch (err) {
      this.logger?.warn?.(
        `[mcp-status] 探测失败（保留上次结果）: ${(err as Error).message}`,
      );
    }
    return this.cached;
  }
}
