/**
 * dsh 的 cordis patch 生成器（P4）。
 *
 * 把**引擎无关的注入快照**落成 dsh 的 profile patch 文件。
 *
 * ## 关键机制（P0 实测，见 md-docs/dsh-worker-p0-poc-report.md 约束 C1）
 *
 * `--patch` 文件里的**平铺条目会被当作"修改已有 id"**——找不到就报
 * `patch: entry "xxx" not found` 并静默跳过。**新增条目必须用 `insert:` 包裹**：
 * ```yaml
 * - insert:
 *     - id: mcp-vteam
 *       name: '@deepseek-ai/dsh-mcp-client'
 *       config: {...}
 * ```
 * 源码依据：`vendor/include/src/index.ts:77-100`（`insert` 无 id → 追加顶层；
 * 有 id → 插入该 group）。
 *
 * 而对**已有条目**的修改（如 `llm-pi-ai` 的 providers）用平铺形态：
 * ```yaml
 * - id: llm-pi-ai
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config: {...}
 * ```
 *
 * ## 三层产物
 *
 * 1. **provider 路由**（模型凭据）：平铺修改 `llm-pi-ai`，每个 provider 一行。
 *    ⚠️ 必须显式写 `api` + `baseURL`（P0 约束 C3：不自带 baseURL 的 provider 会 401）。
 * 2. **平台 MCP**：`insert:` 一条 `dsh-mcp-client`（streamable-http + headers）。
 * 3. **vteam 工具 MCP**：`insert:` 一条 `dsh-mcp-client`（stdio，指向 mcp-tool-server）。
 *
 * @module engine/dsh/patch-builder
 */

/**
 * provider 路由声明（= 模型凭据的引擎侧形态）。
 *
 * 字段对齐 `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiProviderProfile`（P0 实测可用形态）。
 */
export interface DshProviderRoute {
  /** 路由名（vteam 的 providerID）。 */
  route: string;
  /** 凭据环境变量名（spawn 时注入；绝不写进 patch 文件——patch 会落盘）。 */
  apiKeyEnv: string;
  /** 线协议（如 `openai-completions`、`anthropic-messages`）。 */
  api: string;
  /** 端点（**必填**；P0 约束 C3）。 */
  baseURL: string;
  /** 模型清单。 */
  models: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    maxTokens?: number;
  }>;
}

/** MCP 服务器声明（引擎无关 → patch 条目）。 */
export interface DshMcpMount {
  /** 命名空间（工具名前缀）。 */
  serverName: string;
  transport: 'stdio' | 'streamable-http';
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** streamable-http */
  url?: string;
  headers?: Record<string, string>;
  /** 启动失败是否让整棵树启动失败（平台 MCP 建议 true，工具 MCP 建议 false）。 */
  failOnStartupError?: boolean;
}

/** patch 生成输入。 */
export interface DshPatchInput {
  /** provider 路由（模型凭据）。 */
  providers: DshProviderRoute[];
  /** 要挂载的 MCP 服务器。 */
  mcpMounts: DshMcpMount[];
  /** 默认模型路由（`<providerID>/<modelID>`）；用于 agent-default-model 覆盖。 */
  defaultModel?: { provider: string; model: string };
  /** 权限模式（`DSH_PERMISSION_MODE` 的等价 patch 形态；可选）。 */
  permissionMode?: string;
  /** agent 角色策略（提示词前缀注入不计入 patch——DSH 无 per-session system API）。 */
  agentPolicies?: Array<{ name: string; system: string }>;
}

/**
 * 生成 patch YAML 文本。
 *
 * 输出是**纯文本 YAML**（不引 yaml 库：worker 现有依赖里没有 YAML 解析器，
 * 且这里只需要"稳定可读"的输出——加依赖为了几十行输出不值）。
 *
 * ⚠️ 字符串转义：所有模型名/URL/提示词都过 `quote()`，避免冒号/引号破坏 YAML。
 */
export function buildDshPatch(input: DshPatchInput): string {
  const lines: string[] = [
    '# vteam worker 自动生成的 dsh profile patch（勿手改，由 worker 每轮重写）',
    '# 机制：新增条目必须用 insert: 包裹（P0 实测：平铺条目会被当成"修改已有 id"）',
  ];

  // ① provider 路由：修改已有 llm-pi-ai 条目（平铺形态）
  if (input.providers.length > 0) {
    lines.push('', '- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'", '  config:', '    providers:');
    for (const provider of input.providers) {
      lines.push(`      ${quoteKey(provider.route)}:`);
      lines.push(`        apiKeyEnv: ${quote(provider.apiKeyEnv)}`);
      lines.push(`        api: ${quote(provider.api)}`);
      lines.push(`        baseURL: ${quote(provider.baseURL)}`);
      lines.push('        models:');
      for (const model of provider.models) {
        lines.push(`          - id: ${quote(model.id)}`);
        lines.push(`            name: ${quote(model.name)}`);
        if (model.contextWindow !== undefined) {
          lines.push(`            contextWindow: ${model.contextWindow}`);
        }
        if (model.maxTokens !== undefined) {
          lines.push(`            maxTokens: ${model.maxTokens}`);
        }
      }
    }
  }

  // ② 默认模型：修改已有 agent-default-model 条目
  if (input.defaultModel !== undefined) {
    lines.push(
      '',
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      `    provider: ${quote(input.defaultModel.provider)}`,
      `    model: ${quote(input.defaultModel.model)}`,
    );
  }

  // ③ MCP 挂载：insert: 形态（新增条目）
  if (input.mcpMounts.length > 0) {
    lines.push('', '- insert:');
    for (const mount of input.mcpMounts) {
      lines.push(`    - id: mcp-${sanitizeId(mount.serverName)}`);
      lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
      lines.push('      config:');
      lines.push(`        serverName: ${quote(mount.serverName)}`);
      lines.push(`        transport: ${quote(mount.transport)}`);
      if (mount.transport === 'stdio') {
        if (mount.command !== undefined) lines.push(`        command: ${quote(mount.command)}`);
        if (mount.args !== undefined && mount.args.length > 0) {
          lines.push('        args:');
          for (const arg of mount.args) lines.push(`          - ${quote(arg)}`);
        }
        if (mount.env !== undefined && Object.keys(mount.env).length > 0) {
          lines.push('        env:');
          for (const [key, value] of Object.entries(mount.env)) {
            lines.push(`          ${quoteKey(key)}: ${quote(value)}`);
          }
        }
      } else {
        if (mount.url !== undefined) lines.push(`        url: ${quote(mount.url)}`);
        if (mount.headers !== undefined && Object.keys(mount.headers).length > 0) {
          lines.push('        headers:');
          for (const [key, value] of Object.entries(mount.headers)) {
            lines.push(`          ${quoteKey(key)}: ${quote(value)}`);
          }
        }
      }
      lines.push(`        failOnStartupError: ${mount.failOnStartupError === true ? 'true' : 'false'}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** YAML 标量转义（单引号包裹，内部单引号双写——YAML PLAIN/single-quote 标准做法）。 */
export function quote(value: string): string {
  // 单引号风格对 URL/中文/冒号都安全，且不需要处理反斜杠转义
  return `'${value.replace(/'/g, "''")}'`;
}

/** YAML 键转义（键含冒号/空格时用引号）。 */
export function quoteKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : quote(key);
}

/** 条目 id 净化（DSH 的 id 是标识符，不含空格/斜杠）。 */
export function sanitizeId(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
}
