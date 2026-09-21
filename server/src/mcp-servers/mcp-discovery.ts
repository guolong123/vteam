import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * 单个发现工具（仅物化需要的字段）。
 * description 随 Tool.description 列持久化（缺失时为 NULL），为 GET /tools 的后端权威文案。
 */
export interface DiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** discoverMcpTools 入参（mcp_servers 行子集，便于单测构造）。 */
export interface McpServerRecordLike {
  id: string;
  name: string;
  type: string;
  command: unknown;
  url: string | null | undefined;
  headers: unknown;
}

/** 工具发现整体超时：连接 + 握手 + tools/list 全链路 30s。 */
export const MCP_DISCOVERY_TIMEOUT_MS = 30000;

/**
 * 仅透传 string 值（过滤非字符串 header/environment，避免 SDK 传参异常）。
 */
function stringEntries(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}

function isAuthError(e: unknown): boolean {
  if (e instanceof UnauthorizedError) {
    return true;
  }
  return (
    e instanceof Error &&
    /(^|\W)(401|unauthorized|oauth)(\W|$)/i.test(e.message)
  );
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * 经官方 MCP SDK 从已注册服务器发现工具清单（11 篇 §5.1 / FR-803）。
 * - local：StdioClientTransport（command.command 首元为可执行文件，
 *   余元为 args；cwd/environment/timeout 透传；stderr 丢弃免污染 server 日志）
 * - remote：StreamableHTTPClientTransport（url + string 值 headers 透传；
 *   OAuth 不处理——服务端要求 OAuth 时抛错，由调用方映射为 400）
 * 全链路超时 30s（含 local 自定义 timeout 时取 min）；任何路径均在 finally
 * 关闭 client/transport（stdio 子进程随 transport.close 被 kill）。
 */
export async function discoverMcpTools(
  record: McpServerRecordLike,
): Promise<DiscoveredMcpTool[]> {
  let cmdTimeout = MCP_DISCOVERY_TIMEOUT_MS;
  if (
    record.command &&
    typeof record.command === 'object' &&
    !Array.isArray(record.command)
  ) {
    const t = (record.command as { timeout?: unknown }).timeout;
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
      cmdTimeout = Math.min(Math.floor(t), MCP_DISCOVERY_TIMEOUT_MS);
    }
  }

  let client: Client | undefined;
  let transport:
    StdioClientTransport | StreamableHTTPClientTransport | undefined;

  const work = async (): Promise<DiscoveredMcpTool[]> => {
    if (record.type === 'local') {
      const cmd =
        record.command && typeof record.command === 'object'
          ? (record.command as {
              command?: unknown;
              cwd?: unknown;
              environment?: unknown;
            })
          : {};
      const parts = Array.isArray(cmd.command) ? cmd.command : [];
      const [bin, ...args] = parts;
      if (typeof bin !== 'string' || bin.trim().length === 0) {
        throw new Error(
          `local 类型服务器 ${record.name} 缺少可执行的 command.command[0]`,
        );
      }
      transport = new StdioClientTransport({
        command: bin,
        args: args.map((a) => String(a)),
        ...(typeof cmd.cwd === 'string' && cmd.cwd.length > 0
          ? { cwd: cmd.cwd }
          : {}),
        env: { ...getDefaultEnvironment(), ...stringEntries(cmd.environment) },
        stderr: 'ignore',
      });
    } else if (record.type === 'remote') {
      const url = (record.url ?? '').trim();
      if (!url) {
        throw new Error(
          `remote 类型服务器 ${record.name} 缺少合法 url，无法发现工具`,
        );
      }
      transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: stringEntries(record.headers) },
      });
    } else {
      throw new Error(
        `未知 MCP 服务器类型 ${record.type}（仅支持 local/remote）`,
      );
    }

    client = new Client(
      { name: 'vteam-mcp-sync', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);

    const out: DiscoveredMcpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools ?? []) {
        out.push({
          name: t.name,
          description:
            typeof t.description === 'string' ? t.description : undefined,
          inputSchema: (t as { inputSchema?: unknown }).inputSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `MCP 工具发现超时（${cmdTimeout}ms）：${record.name} 连接无响应`,
            ),
          ),
        cmdTimeout,
      );
    });
    return await Promise.race([work(), timeout]);
  } catch (e) {
    if (isAuthError(e)) {
      throw new Error(
        `MCP 服务器 ${record.name} 要求 OAuth 认证，同步暂不支持（请改用 headers 透传静态凭据，或关闭服务端认证）：${toError(e).message}`,
      );
    }
    throw toError(e);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (transport instanceof StreamableHTTPClientTransport) {
      await transport.terminateSession().catch(() => undefined);
    }
    if (client) {
      await client.close().catch(() => undefined);
    } else if (transport) {
      await transport.close().catch(() => undefined);
    }
  }
}
