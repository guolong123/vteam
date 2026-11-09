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
  /**
   * provider 级请求头（如 opencode-go 网关要求 `x-opencode-session`）。
   *
   * 依据：`dsh-llm-pi-ai` 的 `PiAiProviderProfile.headers`（config.d.ts:113-114）。
   * ⚠️ 值是**静态字符串**（不能含密钥；header 里的凭据应走 env + 引擎自己的鉴权）。
   */
  headers?: Record<string, string>;
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
  /**
   * **系统提示词**（`system-prompt` 条目的 `personaPrefix`）。
   *
   * ⚠️ 修正此前的错误结论：DSH 的 system prompt **完全可以配置**，机制有两个：
   * 1. `dsh-system-prompt` 的 config（`personaPrefix` / `personaSuffix` /
   *    `includeHarnessIdentity` / `includeRuntimeContext` / `toolOrder`）；
   * 2. `dsh-persona` 在 preset 内为**单个 agent** shadow 全局 persona
   *    （`dsh-persona` 的 `prefix` / `suffix` / `complete`）。
   *
   * 它们在 patch 层都是**平铺修改已有条目**（`- id: system-prompt`），不是 `insert:`。
   * 源码依据：`packages/core/system-prompt/src/index.ts:437-446`（Config schema）；
   * `packages/bundle/sdk-minimal/cordis.patch.yml:113-118` 的现成范例
   * （`personaPrefix: !!js process.env.DSH_SYSTEM_PROMPT ?? '...'`）。
   *
   * 实测：`--dump-config` 已确认平铺 patch 能改到 `personaPrefix`。
   */
  persona?: {
    /** 主提示词（渲染为 `deployment:persona-prefix` section，order 0）。 */
    prefix: string;
    /** 收尾提示词（order 10200，可选）。 */
    suffix?: string;
    /** 是否保留 DSH 固定开场白（`You are an AI agent powered by DeepSeek Harness.`）。 */
    includeHarnessIdentity?: boolean;
    /** 是否启用动态运行时上下文（cwd/时间等）。 */
    includeRuntimeContext?: boolean;
  };
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

  // ① provider 路由：**insert 一个 llm-pi-ai 插件实例**。
  //
  // 旧实现平铺 `- id: llm-pi-ai` 想“修改已有条目”，但 sdk profile 的 base 组合里
  // 并没有 llm-pi-ai（只有 dsh-llm + deepseek extension），平铺条目会被静默忽略，
  // 导致自定义 provider（如 ehsy）永远注册不上（no adapter registered）。
  // 另外 deepseek-official 由 base 的 deepseek extension 提供，不能放进 pi-ai 里，
  // 否则 provider route 冲突会让插件整体注册失败；这里只 insert 非内置路由。
  const piProviders = input.providers.filter(
    (provider) => provider.route !== 'deepseek-official',
  );
  if (piProviders.length > 0) {
    lines.push('', '- insert:');
    lines.push('    - id: llm-pi-ai');
    lines.push("      name: '@deepseek-ai/dsh-llm-pi-ai'");
    lines.push('      config:');
    lines.push('        providers:');
    for (const provider of piProviders) {
      lines.push(`          ${quoteKey(provider.route)}:`);
      lines.push(`            apiKeyEnv: ${quote(provider.apiKeyEnv)}`);
      lines.push(`            api: ${quote(provider.api)}`);
      lines.push(`            baseURL: ${quote(provider.baseURL)}`);
      if (provider.headers !== undefined && Object.keys(provider.headers).length > 0) {
        lines.push('            headers:');
        for (const [key, value] of Object.entries(provider.headers)) {
          lines.push(`              ${quoteKey(key)}: ${quote(value)}`);
        }
      }
      lines.push('            models:');
      for (const model of provider.models) {
        lines.push(`              - id: ${quote(model.id)}`);
        lines.push(`                name: ${quote(model.name)}`);
        if (model.contextWindow !== undefined) {
          lines.push(`                contextWindow: ${model.contextWindow}`);
        }
        if (model.maxTokens !== undefined) {
          lines.push(`                maxTokens: ${model.maxTokens}`);
        }
      }
    }
  }

  // ② 系统提示词：**平铺修改** system-prompt 条目（不是 insert，它在 base 里已存在）
  // 这是 vteam 角色人设（岗位职责/协作协议）进模型 system 段的**唯一正规通道**——
  // 比"拼进用户消息前缀"更正确：不占用户消息、不进对话记录、KV cache 前缀稳定。
  // **始终**写 system-prompt 行（读 env，缺省空串）：
  // 驱动按角色重启运行时时只需变更 env，patch 不变 ⇒ 无需重写 patch。
  // 这是唯一实测可靠的 persona 通道（preset 的 dsh-persona 行需要 agent scope，
  // registry.register() 不满足 ⇒ 挂载失败）。
  {
    lines.push('', '- id: system-prompt', '  config:');
    lines.push(
      `    personaPrefix: !!js process.env.DSH_SYSTEM_PROMPT ?? ''`,
    );
    lines.push(
      `    personaSuffix: !!js process.env.DSH_SYSTEM_PROMPT_SUFFIX ?? ''`,
    );
  }

  // ③ 默认模型：修改已有 agent-default-model 条目
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

/**
 * 生成 `!!js` 环境变量表达式（提示词从 **env** 读取，不写进 patch 文件）。
 *
 * 为什么不直接写进 patch：vteam 的系统提示词含完整岗位职责/协作协议（数千字），
 * 写进 patch 会导致：
 * - patch 文件巨大且每次注入都要重写（IO 开销）；
 * - 提示词内容留在磁盘（patch 落在 workDir，可能被读取）。
 * 用 env 注入（对齐 `sdk-minimal` 的 `DSH_SYSTEM_PROMPT` 惯例）既短又安全，
 * 且驱动可以在 spawn 时按会话切换人设。
 *
 * @param envName 环境变量名
 * @param fallback 缺省值（env 未设时用）
 */
export function yamlEnvExpression(envName: string, fallback: string): string {
  // !!js 表达式里用单引号字面量；fallback 里的单引号需转义（YAML 层由 quote 处理）
  const escaped = fallback.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `process.env.${envName} ?? '${escaped}'`;
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
