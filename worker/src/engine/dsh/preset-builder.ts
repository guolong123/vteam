/**
 * dsh agent-preset 生成器（P6）。
 *
 * 把 **vteam 的 Agent 概念**映射成 DSH 的 `@deepseek-ai/dsh-agent-preset` 定义。
 *
 * ## 为什么这个映射是"天然适合"的（源码核实）
 *
 * | vteam `Agent`（schema.prisma:649-680） | DSH `agent-preset` |
 * |---|---|
 * | `agentKey`（`vteam-developer`） | `config.id`（preset 身份） |
 * | `prompt`（四方向长文本） | `plugins[].persona.prefix`（**persona 通道**，进 system 段） |
 * | `policyId` → 权限矩阵 | `plugins[]` 内 permission preset 行 |
 * | `AgentSkill` 关联 | `plugins[].skill-filesystem` + 按 preset 的技能目录 |
 * | `defaultModelId` | `plugins[].agent-default-model`（可选） |
 *
 * 依据：`packages/preset/agent-preset/README.md`（`id` + `plugins` 两个必填字段）、
 * `packages/bundle/web-app/presets/standard.patch.yml`（真实范例，`persona` 行即身份）。
 *
 * ## 关键收益（相对"进程级 persona + 重启换人设"）
 *
 * - **一个运行时承载多个角色**：registry README 明确 "One process can run several compositions"
 *   ⇒ PM/开发/测试并发不再需要 3 个 350MB 进程。
 * - **切换零重启**：`select()` 是会话创建期绑定（`agent-preset/locked` 保护首 turn 之前）。
 * - **工具/技能按角色隔离**：每个 preset 自己的 plugins 子树。
 *
 * @module engine/dsh/preset-builder
 */

/** vteam Agent 的运行时投影（引擎无关裁剪；字段取自 schema.prisma:649-680）。 */
export interface VteamAgentSpec {
  /** vteam Agent id。 */
  id: string;
  /** agentKey（`vteam-<key>`；作为 preset id 的来源，保证稳定且可读）。 */
  agentKey: string;
  /** 展示名。 */
  name: string;
  /** 岗位提示词（长文本；进 persona prefix）。 */
  prompt: string;
  /** persona 性格（PERSONA_LIBRARY key）；可选，作为 suffix 提示。 */
  persona?: string;
  /** 绑定的模型（`providerID/modelID`）；可选。 */
  defaultModelId?: string;
  /** 该 Agent 可用的技能名清单（来自 AgentSkill）；可选。 */
  skills?: string[];
}

/** preset 定义（对应一条 `@deepseek-ai/dsh-agent-preset` 的 config）。 */
export interface DshPresetDefinition {
  /** preset 身份（= agentKey）。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 描述（roster 展示用）。 */
  description?: string;
  /** roster 顺序。 */
  order?: number;
  /** 子插件条目（YAML 结构）。 */
  plugins: Array<Record<string, unknown>>;
}

/**
 * preset id 规范化（DSH 的 preset id 是任意非空字符串，但用 agentKey 更可读）。
 *
 * 用 agentKey 而非 vteam 的 `id`（`a_developer`）：agentKey 在 vteam 侧是
 * `vteam-developer` 这种稳定可读标识，且**跨环境一致**（seed 库与生产库都一样），
 * 适合作为会话持久化的 preset 身份（DSH 会把 preset id 记进会话日志）。
 */
export function presetIdFor(agent: VteamAgentSpec): string {
  return agent.agentKey.trim() !== '' ? agent.agentKey : agent.id;
}

/**
 * vteam Agent → DSH preset 定义。
 *
 * 生成的 `plugins` 结构（对齐 `web-app/presets/standard.patch.yml` 的写法）：
 * 1. `persona` —— **身份**（岗位提示词进 system 段，这是关键）
 * 2. `time-context` —— 时间上下文（vteam 提示词里用得上）
 * 3. `skill-filesystem` —— 技能发现（按 preset 隔离）
 *
 * ⚠️ 工具集（tool-bash/tool-fs 等）**不在这里**：vteam 的工具来自平台 MCP
 * （`mcp-vteam` 行）与 worker 内置工具族，它们挂在宿主层而非 preset 层。
 * preset 内再加一套会与宿主层的重复注册冲突。
 */
export function buildPresetDefinition(agent: VteamAgentSpec): DshPresetDefinition {
  const id = presetIdFor(agent);
  const plugins: Array<Record<string, unknown>> = [
    // ① 身份：岗位提示词走 persona（进模型 system 段，不污染用户消息）
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        // personality 性格提示拼在岗位提示词之后（vteam 的 buildSystemInstructions 同序）
        prefix:
          agent.persona !== undefined && agent.persona.trim() !== ''
            ? `${agent.prompt}\n\n【性格倾向】${agent.persona}`
            : agent.prompt,
      },
    },
    // ② 时间上下文（vteam 提示词要求 agent 感知当前时间）
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    // ③ 技能发现（preset 隔离；实际技能内容由 worker 注入到 .dsh/skills）
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
  ];

  if (agent.skills !== undefined && agent.skills.length > 0) {
    // 技能清单作为一条 context section（逐会话可读；内容本身在 skill 目录里）
    plugins.push({
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65536 },
    });
  }

  return {
    id,
    name: agent.name,
    description: `vteam 角色：${agent.name}（${agent.agentKey}）`,
    plugins,
  };
}

/**
 * 生成 preset 定义的 **cordis patch 文本**（`insert:` 形态，新增条目）。
 *
 * 为什么用 `insert:`：`agent-preset-registry` 是新增行（sdk profile 原本没有），
 * 且每个 preset 也是新增的 `@deepseek-ai/dsh-agent-preset` 行。
 * P0 实测约束：**新增条目必须用 `insert:` 包裹**，平铺会被当成"修改已有 id"。
 */
export function renderPresetPatch(presets: DshPresetDefinition[], defaultPresetId: string): string {
  const lines: string[] = [
    '# vteam worker 自动生成：dsh agent-preset 定义（勿手改）',
    '# 机制：新增条目必须用 insert: 包裹（平铺会被当成修改已有 id）',
    '',
    '- insert:',
    '    - id: agent-preset-registry',
    "      name: '@deepseek-ai/dsh-agent-preset-registry'",
    '      config:',
    `        default: ${quote(defaultPresetId)}`,
  ];

  for (const preset of presets) {
    lines.push(`    - id: preset-${sanitizeId(preset.id)}`);
    lines.push("      name: '@deepseek-ai/dsh-agent-preset'");
    lines.push('      config:');
    lines.push(`        id: ${quote(preset.id)}`);
    lines.push(`        name: ${quote(preset.name)}`);
    if (preset.description !== undefined) {
      lines.push(`        description: ${quote(preset.description)}`);
    }
    if (preset.order !== undefined) {
      lines.push(`        order: ${preset.order}`);
    }
    lines.push('        plugins:');
    for (const plugin of preset.plugins) {
      lines.push(renderPluginEntry(plugin));
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** 渲染一条 plugin 条目（缩进 10 空格，位于 `plugins:` 之下）。 */
function renderPluginEntry(plugin: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`          - id: ${sanitizeId(String(plugin.id ?? 'row'))}`);
  if (plugin.name !== undefined) {
    lines.push(`            name: ${quote(String(plugin.name))}`);
  }
  if (plugin.disabled !== undefined) {
    lines.push(`            disabled: ${plugin.disabled === true ? 'true' : 'false'}`);
  }
  if (plugin.config !== undefined && typeof plugin.config === 'object' && plugin.config !== null) {
    lines.push('            config:');
    for (const [key, value] of Object.entries(plugin.config as Record<string, unknown>)) {
      if (typeof value === 'string') {
        // 长文本用 YAML 块标量（|）保持可读；短值用单引号
        if (value.includes('\n') || value.length > 80) {
          lines.push(`              ${key}: |-`);
          for (const textLine of value.split('\n')) {
            lines.push(`                ${textLine}`);
          }
        } else {
          lines.push(`              ${key}: ${quote(value)}`);
        }
      } else {
        lines.push(`              ${key}: ${JSON.stringify(value)}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * vteam 内置模板角色（与 `server/prisma/seed.ts` 的 7 个模板 Agent 对齐）。
 *
 * 为什么硬编码而不是从 API 拉：`GET /agents` 需要**用户 JWT**（worker 只有
 * worker-token，无权限读平台 Agent 定义）。而 worker 其实**不需要** Agent 的完整
 * 定义——server 派发时已经通过 `payload.system` 下发了完整角色提示词
 * （`buildSystemInstructions`，数千字含身份/职责/协作协议）。
 *
 * preset 的作用是**按角色隔离工具/技能上下文**（多角色共享一个运行时），
 * 故只需静态的 roster 骨架；真实提示词在会话创建时经 persona 通道注入。
 *
 * ⚠️ 这些是 vteam 的**稳定出厂角色**（seed 数据，跨环境一致）。自定义 Agent
 * 由 server 派发时的 system 承载，preset 用默认骨架即可。
 */
export const VTEAM_BUILTIN_ROLES: readonly { agentKey: string; name: string }[] = [
  { agentKey: 'vteam-product', name: '产品经理' },
  { agentKey: 'vteam-project_manager', name: '项目经理' },
  { agentKey: 'vteam-architect', name: '架构师' },
  { agentKey: 'vteam-developer', name: '开发者' },
  { agentKey: 'vteam-tester', name: '测试' },
  { agentKey: 'vteam-plan', name: '计划员' },
  { agentKey: 'vteam-librarian', name: '知识管理员' },
];

/**
 * 生成内置角色的 preset roster（静态骨架）。
 *
 * 每个 preset 的 persona prefix 是**占位**（真实提示词由 server 派发的 system
 * 在会话创建时经 `switchPersona`/persona 通道注入）。这里放一个可读的标识，
 * 便于 DSH 面板里区分角色。
 */
export function buildBuiltinRoster(): DshPresetDefinition[] {
  return VTEAM_BUILTIN_ROLES.map((role, index) => ({
    id: role.agentKey,
    name: role.name,
    description: `vteam 内置角色：${role.name}`,
    order: index + 1,
    plugins: [
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { prefix: `你是 vteam 虚拟团队中的${role.name}（${role.agentKey}）。` },
      },
      { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
      { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    ],
  }));
}

/** YAML 单引号转义。 */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 条目 id 净化。 */
function sanitizeId(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48);
}
