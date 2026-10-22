/**
 * T4b 资源注入执行器：worker 从控制面拉取三类资源并注入本地 opencode 配置目录。
 *
 * - injectSkills()：GET /skills（enabled=true）→ 逐个 GET /skills/:id/content →
 *   写 <workDir>/.opencode/skills/<name>/SKILL.md（serve 启动时 discoverSkills 扫描）
 * - injectTools()：GET /tools（enabled=true）→ 渲染 renderCustomToolPlugin →
 *   写 <workDir>/.opencode/plugins/<action>.ts（T19：**v2 已移除 `.opencode/tools/` 的
 *   文件自动发现**，工具只能经插件 `ctx.tool.transform` 注册；v1 也扫描 `.opencode/plugins/`
 *   ⇒ 同一份产物两代通用）
 * - injectMcp()：GET /mcp-servers（enabled=true）→ 生成 <workDir>/opencode.json 的
 *   mcp 节（v2 原生形：`mcp.servers.<name>`；合并保留其他配置节）
 * - injectAll()：三者组合，供 T4a 命令回调与 worker 启动前调用
 *
 * ⚠️ **T15：写出的配置一律是 opencode **v2 原生形状****（实测 opencode v2.0.28 +
 * 官方 config.json schema）。v2 虽接受 v1 形配置，但会**静默归一化**（= 看着有、实际被改写）：
 * - `mcp`（扁平）→ `mcp.servers`；`mcp.<n>.enabled` → `mcp.servers.<n>.disabled`（**极性相反**）；
 *   `mcp.<n>.timeout:<ms>` → `{catalog, execution}`（**`startup` 段丢失**，不是补默认值）；
 * - `plugin` → `plugins`；
 * - `agent` → `agents`，**且**键名 `prompt` → `system`（**必须同时改**：v2 原生 `agents:` 节里的
 *   `prompt` 是未知键 → **被静默丢弃、无任何告警** ⇒ 角色提示全丢）。
 *
 * 鉴权：所有拉取带 X-Worker-Token（与注册/心跳同 token，对齐 server WorkerOrJwtGuard）。
 * 清理：停用资源的残留文件经 manifest（<workDir>/.opencode-worker-inject.json）比对后
 * 删除——只删本注入器写过的文件，不误伤 git.ts（内置注入）与用户文件。T19 起工具产物落在
 * `.opencode/plugins/`，manifest 的 `toolPlugins` 记它；升级前的 `.opencode/tools/` 残留由
 * `legacyTools` 一次性清掉（v2 已不发现该目录，留着只会误导读者与清理逻辑）。
 *
 * ⚠️ **失败中性化 = 保留，不是删除**（2026-10-22 批次 D-1 修正）：`/agent-policies` 拉取失败
 * /形状非法/角色集为空时，本注入器**不删**上次注入的受管 agent 块——删掉它等于让 agent 退回
 * **引擎默认权限**（比平台配置的权限集**更宽**）⇒ 一次控制面抖动就把权限**放大**了
 * （fail-open）。改为保留 ⇒ 权限集**既不收窄也不放大**（agent 跑在**上次已知**权限集上）。
 * 首次注入（无历史受管块）无块可保留，行为同前（不写入受管定义），但必须显式告警。
 *
 * worker 独立进程铁律：不 import server 代码（apiUrl/WORKER_TOKEN_HEADER 复用 registry-client 常量）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { apiUrl, WORKER_TOKEN_HEADER } from '../client/registry-client';
import { readOmoAgents, writeOmoAgents } from './omo-config';
import { OMO_BUNDLED_MARKER, readOmoEnabled } from './omo-enabled';
import {
  AgentPoliciesResponse,
  buildAgentDefinitions,
  buildPermissionRules,
} from './opencode-config-builder';
import {
  CustomToolArg,
  CustomToolArgType,
  CustomToolFileDef,
  renderCustomToolPlugin,
} from './custom-tool';
import {
  SYSTEM_HANDOFF_PLUGIN_FILE,
  installSystemHandoffPlugin,
} from '../driver/v2-system-handoff';

/** 注入器日志接口（默认 console，测试可静默）。 */
export interface ResourceLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface ResourceInjectorOptions {
  /** server 基址（如 http://localhost:3000）。 */
  serverUrl: string;
  /** X-Worker-Token 鉴权 token（config.workerToken）。 */
  workerToken: string;
  /** worker 全局唯一 id（config.workerId；拉取时带 x-worker-id，server 按 worker 覆盖内置 MCP 地址）。 */
  workerId: string;
  /** opencode serve 工作目录（注入落点根）。 */
  workDir: string;
  /** fetch 注入点（测试用）；默认 globalThis.fetch。 */
  fetchImpl?: typeof fetch;
  logger?: ResourceLogger;
}

export interface InjectReport {
  skills: string[];
  tools: string[];
  /**
   * 工具注入**明细**（让「0 tools」可解释）。
   *
   * ⚠️ 缺省 = 旧形态报告（没有明细）⇒ 消费方必须容忍 undefined。
   */
  toolBreakdown?: ToolInjectionBreakdown;
  mcpServers: string[];
  /**
   * agent 策略注入结果（Todo 14 上报能力位的成功/报告信号）：
   * - 成功（`/agent-policies` 拉取成功且角色集非空）→ `{ enabled: true, names: 本次写入名 }`；
   * - 失败中性化（拉取失败或角色集为空）→ `{ enabled: false, names: [] }`。
   *
   * ⚠️ `enabled: false` 的语义 = **本轮没有刷新** agent 策略（不是「没有受管块」）。
   * 批次 D-1 起失败中性化**保留**上次受管块（权限集不变），但平台侧的能力位门
   * （`workerSupportsAgentPolicies`）据此判定该 worker 的策略**已陈旧** ⇒ 不派发
   * 需要策略的 agent（stale-true 防护在派发侧，不在配置侧）。陈旧事实另记在
   * manifest 的 `agentPoliciesStale` 键 + 注入器告警日志里。
   */
  agentPolicies: { enabled: boolean; names: string[] };
}

/**
 * 工具注入的**明细**（控制面工具目录 → 实际渲染成 opencode 工具插件的账）。
 *
 * ⚠️ **为什么需要它**：控制面的 `GET /tools` 返回的是**工具目录**
 * （= 能力/权限点目录：opencode 原生工具 + MCP 服务器的工具条目 + 平台自定义工具），
 * 而 worker 注入的是**自定义工具插件**（落 `<workDir>/.opencode/plugins/<action>.ts`）。
 * **两个数不是同一个类别**——目录里的条目数 ≠ 插件数。
 * 没有这份明细，日志里那个「0 tools」既可能是"平台没有自定义工具"、
 * 也可能是"拉取失败"、还可能是"有但都不可注入"——三者无法区分（静默失败）。
 */
export interface ToolInjectionBreakdown {
  /** 控制面返回的**启用**工具条数（拉取成功口径；停用工具被 `enabled=true` 过滤掉）。 */
  fetched: number;
  /** 其中 `execution=mcp` 的条数（由 `mcp.servers` 配置节承载，不渲染为插件）。 */
  mcpType: number;
  /** 其中 `source=builtin` 的条数（opencode 原生工具的目录项，不渲染为插件）。 */
  builtin: number;
  /** 其中缺少执行细节（`x-execution`）而未渲染的条数（**真实缺口**，非 builtin）。 */
  missingExecution: number;
  /** 实际渲染成 opencode 工具插件的条数。 */
  injected: number;
}

/** 控制面资源记录最小形态（来自 GET /skills、/tools、/mcp-servers；本地写入亦复用）。 */
export interface SkillRecord {
  id: string;
  name: string;
}
/** 本地写入用的技能记录（name + SKILL.md 全文）。 */
export interface ResolvedSkill {
  name: string;
  content: string;
}
export interface ToolRecord {
  id: string;
  action: string;
  name: string;
  execution: string;
  schema: Record<string, unknown> | null;
  /**
   * 工具来源（`builtin` / `custom` / `mcp`；控制面 `tools` 表的列）。
   *
   * ⚠️ 缺省 = 未知来源（按 `custom` 处理 ⇒ 缺执行细节会告警）。
   */
  source?: string;
}
export interface McpServerRecord {
  id: string;
  name: string;
  type: string;
  command: { command?: string[]; cwd?: string; environment?: unknown; timeout?: number } | null;
  url: string | null;
  headers: Record<string, string> | null;
  oauth: unknown;
  enabled?: boolean;
  /** remote 顶层可选超时（11 §5.1 remote 字段含 timeout?；服务端当前模型未提供，兼容预留）。 */
  timeout?: number;
}

/** manifest 键：记录上次注入的文件/目录名，用于停用资源清理。 */
interface InjectManifest {
  skills?: string[];
  /** v2 形态工具插件（落 `.opencode/plugins/<file>`，T19 起）。 */
  toolPlugins?: string[];
  /**
   * 历史 v1 形态工具文件（落 `.opencode/tools/<file>`）——T19 升级后的一次性清理清单。
   * 清理完即清空；`tools` 键是升级前的旧名（读一次后删除）。
   */
  legacyTools?: string[];
  /** @deprecated 升级前的旧键（= v1 形态工具文件列表）；仅用于迁移清理。 */
  tools?: string[];
  mcpServers?: string[];
  /**
   * 上次写入 opencode.json **`agents` 节**的受管 agent 名（仅注入器写入的名；用户手写
   * 的 agent 键不在此列，清理时保留）。
   */
  agentNames?: string[];
  /**
   * 受管 agent 块**未刷新**标记（批次 D-1）。
   *
   * ⚠️ 语义：`true` = 上一次 `/agent-policies` 拉取失败（或形状非法/角色集为空），
   * **受管块被保留**（未刷新）⇒ agent 正运行在**上次已知**权限集上（陈旧但**未放大**）。
   * 成功注入时清零（块已刷新）。
   *
   * 为什么单独一个键而不是把 `agentNames` 清空：清空会让下一次清理逻辑以为「受管块
   * 不存在」而下轮把它当垃圾删掉；保留名字 + 标记陈旧，才是与「块仍在配置里」一致的记账。
   */
  agentPoliciesStale?: boolean;
  /**
   * 逐消息 system blob 的**插件交接**产物文件名（`.opencode/plugins/<file>`）。
   *
   * ⚠️ **单列一个键**（不进 `toolPlugins`）：`toolPlugins` 的清理语义是"上次注入过、
   * 本次不在启用集 ⇒ 删文件"⇒ 把这个**常驻**插件塞进去会被下一次注入误删。
   * 单列之后：清理逻辑不碰它，且 manifest 仍然如实记录"这个文件是注入器写的"。
   */
  systemHandoffPlugin?: string;
}

const MANIFEST_REL = '.opencode-worker-inject.json';
const DEFAULT_PAGE_SIZE = 100;
/** tools 注入文件名非法字符（opencode 工具名约束，安全兜底）。 */
const INVALID_FILE_CHARS = /[^a-z0-9-_.]/g;

/**
 * T15：opencode **v2 原生**配置段名（实测 opencode v2.0.28 `GET /api/config` 回显 +
 * 官方 config.json schema）。
 *
 * - `agents`：v2 原生 agent 段（v1 段名 `agent` 已被 v2 标为 deprecated）；
 * - `mcp`：v2 原生 MCP 段（服务器在 `mcp.servers` 下；v1 的扁平形已 deprecated）；
 * - `plugins`：v2 原生插件段（v1 段名 `plugin` 已 deprecated）。
 *
 * ⚠️ v1 段名**不能留在文件里**：配置在持久卷上（镜像不是）⇒ 升级后旧段名会一直在；
 * 而 v2 遇到「v1 段 + v2 段并存」时**静默归一化**（可能产生归一化诊断 WARN），
 * 且 v2 原生 `agents:` 节里的 `prompt` 键**静默丢弃** ⇒ 旧形态必须被**迁走**。
 */
const SECTION_AGENTS = 'agents';
const SECTION_AGENT_LEGACY = 'agent';
const SECTION_MCP = 'mcp';
const SECTION_PLUGINS = 'plugins';
const SECTION_PLUGIN_LEGACY = 'plugin';

/**
 * T15：v1 单值 timeout（ms）→ v2 **三段** timeout（`{startup, catalog, execution}`）。
 *
 * ⚠️ v2 归一化 v1 单值时只得到 `{catalog, execution}`——**`startup` 段丢失**
 * （**不是**被默认值补齐）⇒ 必须显式写三段（计划 T15 硬闸门：`startup` 段不得缺失）。
 *
 * 分段口径：v1 只有一个"整个 MCP 操作"预算，v2 是三段各自独立计时 ⇒ **同一个值写满三段**
 * （`startup` = 进程启动/握手、`catalog` = 工具目录拉取、`execution` = 单次工具调用）。
 *
 * ⚠️ 已知语义差异（记录在案，非本任务范围）：总预算上界由 v1 的 1× 变成 v2 的 3×。
 * 收紧它需要产品决策（哪一段该更短）。
 */
export function buildMcpTimeout(ms: number): {
  startup: number;
  catalog: number;
  execution: number;
} {
  const value = Math.floor(ms);
  return { startup: value, catalog: value, execution: value };
}

/**
 * T15：MCP OAuth 字段 v1 camelCase → **v2 snake_case**。
 *
 * （实测 opencode v2.0.28 `Mcp.OAuthConfigEncoded`：`client_id` / `client_secret` /
 * `scope` / `callback_port` / `redirect_uri` / `auth_server_metadata_url`；该对象
 * `additionalProperties:false` ⇒ v1 的 camelCase 会被 v2 **忽略**。）
 */
const MCP_OAUTH_FIELD_RENAMES: Readonly<Record<string, string>> = {
  clientId: 'client_id',
  clientSecret: 'client_secret',
  callbackPort: 'callback_port',
  redirectUri: 'redirect_uri',
  authServerMetadataUrl: 'auth_server_metadata_url',
};

/**
 * OmO 插件在 opencode.json plugin 节里的条目。
 *
 * 用包名 + @latest（与官方安装器写入 $HOME 配置的写法一致）而非镜像内绝对路径：
 * OmO 是"安装器 + 插件"形态，包由 bun 在运行时按此说明解析，写死路径反而与安装器
 * 生成的状态脱节。
 */
const OMO_PLUGIN_ENTRY = 'oh-my-openagent@latest';

/**
 * 禁用 v2 内置浏览器插件的条目（实测 opencode v2.0.28：内置插件 id = `opencode.browser`）。
 *
 * ⚠️ **必须禁**：该内置插件注册了一个**名为 `browser`** 的工具 → 与平台自己的 browser
 * 工具（agent-browser）**同名冲突**，后果是**静默遮蔽**：平台工具进了全局注册表
 * （`ctx.tool.list()` 能看到），但**模型的 `tools[]` 里没有它** → 模型永远调不到，
 * **全程没有任何报错**（实测差别：`tools[]` 12 个 vs 13 个）。
 *
 * 平台必须保留 `browser` 这个工具名（v1 时代就是它，且 v1/v2 行为必须一致）⇒ 只能让内置的让位。
 * 用**精确 id** 禁用是 T6 唯一验证过的安全手段（`plugins: ["-*"]` 会把内置 agent/provider
 * 一起关掉 → `Agent not found: "build"`；精确 id 不影响其它内置插件）。
 */
const DISABLE_BUILTIN_BROWSER_ENTRY = '-opencode.browser';
/**
 * 判定 plugin 条目是否指向 OmO（正式名 oh-my-openagent，旧正式名 oh-my-opencode）。
 *
 * ⚠️ 必须**排除** `oh-my-opencode-slim`——那是第三方精简 fork，与 OmO 是两个不同插件。
 * 早期 vteam 误装过 slim，其条目残留在持久化卷的 opencode.json 里；若用宽松匹配
 * （如 /oh-my-(openagent|opencode)/ 会被 "oh-my-opencode-slim" 命中），就会把 slim
 * 误判成"OmO 已在"，于是永不写入真正的 OmO 条目 → 插件静默不加载（实测踩坑）。
 */
const OMO_ENTRY_RE = /(^|\/)oh-my-(openagent|opencode)(@|$|\/)/;
/** 第三方精简 fork 条目：从配置中清除，避免与 OmO 并存冲突。 */
const OMO_SLIM_ENTRY_RE = /oh-my-opencode-slim/;

/**
 * 内置 OmO 的 **v2 形态入口**能力标记：`/opt/omo-bundled.json` 的 `v2` 字段
 * （Dockerfile 构建期写入；见 `worker/Dockerfile` 的 `omo capability marker`）。
 *
 * ── 为什么需要它（v2 适配的核心坑） ─────────────────────────────────────
 * v2 的三个破坏性变更之一就是**插件 API**：v1 插件导出 `{server}`，v2 插件导出
 * `{id, setup}` ⇒ **v1 形态的插件实现在 v2 不会运行**（官方迁移指南明写）。
 * 而镜像里内置的 OmO 是 `bunx oh-my-openagent@latest install --platform=opencode`
 * 装出来的 **v1 形态**包 ⇒ 在 v2 上**注册了也加载不了**：
 * - `plugins` 是 **v2 合法键** ⇒ **不会**产生「配置归一化诊断」（那个闸门查不到它）；
 * - serve 只会报一条插件加载失败 ⇒ **静默失败**（平台其余能力照常工作）。
 * ⇒ 必须由**镜像**显式声明"我内置的 OmO 有没有 v2 形态入口"，注入器据此决定
 * **是否注册**——不能靠猜，也不能靠"注册了看报不报错"（那是静默失败）。
 *
 * 标记语义：
 * - `v2: true`  → 内置 OmO **有 v2 形态入口** → 可注册；
 * - `v2: false` → 内置 OmO **只有 v1 形态** → **不注册**（并清掉历史残留条目）；
 * - **字段缺失 / 文件不存在** → **未知** → 保持既有行为（注册）并打一条告警
 *   （"不知道" ≠ "知道不能用"；镜像作者应显式声明该字段）。
 */
const OMO_BUNDLED_V2_CAPABILITY_FIELD = 'v2';
/**
 * 已删除的 role-guard 插件条目匹配（任意历史写法）：`plugin` 数组清理用。
 * 与 `purgeLegacyGuardArtifacts` 配套——只匹配该层，不误伤用户手写条目。
 */
const LEGACY_GUARD_ENTRY_RE = /vteam-role-guard/;

/** 平台 MCP 远端条目名（与 server `PLATFORM_MCP_SERVER_NAME` 对齐）。 */
const VTEAM_MCP_SERVER_NAME = 'vteam';

/**
 * vteam 远端条目 MCP 客户端超时下限 ms：`secret_command` 阻塞调用最坏总预算
 * 855s（540s 敏感值输入 + 300s 命令 + 15s 裕量），不设下限会被 OpenCode 默认
 * 超时在预算内掐断 → 注入点硬编码本下限，不依赖客户端默认值、不要求 DB 迁移。
 */
export const VTEAM_MCP_TIMEOUT_FLOOR_MS = 900_000;

/**
 * vteam 远端条目最终 timeout：`VTEAM_MCP_TIMEOUT_MS` 可覆盖，但一律 clamp 到
 * `VTEAM_MCP_TIMEOUT_FLOOR_MS`（缺省/空串/非十进制整数/非正数 → 直接取下限）。
 */
export function resolveVteamMcpTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.VTEAM_MCP_TIMEOUT_MS;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    return VTEAM_MCP_TIMEOUT_FLOOR_MS;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return VTEAM_MCP_TIMEOUT_FLOOR_MS;
  }
  return Math.max(parsed, VTEAM_MCP_TIMEOUT_FLOOR_MS);
}


export class ResourceInjector {
  private readonly serverUrl: string;
  private readonly workerToken: string;
  private readonly workerId: string;
  private readonly workDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: ResourceLogger;

  constructor(options: ResourceInjectorOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.workerToken = options.workerToken;
    this.workerId = options.workerId;
    this.workDir = options.workDir;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
  }

  /**
   * 是否接了日志出口。
   *
   * ⚠️ **未接 = 静默失败**：注入器自己的诊断（拉取失败、跳过原因、中性化）
   * 全部走 `this.logger`——不接线 ⇒ 这些告警**一条都不会打印**，
   * 平台只看到"注入完成：0 tools"，却不知道是"本来就没有"还是"拉取炸了"。
   */
  get hasLogger(): boolean {
    return this.logger !== undefined;
  }

  /**
   * 注入全部四类资源，返回报告。
   *
   * 单写者保证：`opencode.json` 全程只有 `injectMcpAndAgents()` 内的一次
   * read-modify-write（mcp + plugin + agent 三节同写）；skills/tools 只碰各自
   * 目录。mcp/agent 合并放在 skills/tools 之后串行执行，避免 manifest 并发读写。
   */
  async injectAll(): Promise<InjectReport> {
    const policiesPromise = this.fetchAgentPoliciesSafe();
    const [skills, toolResult] = await Promise.all([
      this.injectSkills(),
      this.injectToolsDetailed(),
    ]);
    const policies = await policiesPromise;
    const { mcpServers, agentPolicies } = await this.injectMcpAndAgents(policies);
    return {
      skills,
      tools: toolResult.actions,
      toolBreakdown: toolResult.breakdown,
      mcpServers,
      agentPolicies,
    };
  }

  /**
   * 拉取 `GET /agent-policies`（与 `/mcp-servers` 同鉴权：`X-Worker-Token` +
   * `x-worker-id`，见 `getJson`）。失败/形状非法/agent 集为空 → 返回 null（调用方
   * 走失败中性化），**永不抛错**（注入链不因策略拉取失败而中断 skills/tools/mcp）。
   *
   * ⚠️ 返回 null **不等于**「删掉受管块」：中性化路径**保留**上次受管块（批次 D-1），
   * 权限集不变（删掉 = 退回引擎默认 = 权限放大）。此处只报「本轮不刷新」。
   */
  async fetchAgentPoliciesSafe(): Promise<AgentPoliciesResponse | null> {
    let data: AgentPoliciesResponse;
    try {
      data = await this.getJson<AgentPoliciesResponse>('/agent-policies', {});
    } catch (err) {
      this.logger?.warn?.(
        `[inject] /agent-policies 拉取失败，本轮不刷新受管 agent（保留上次受管块，权限集不变）：` +
          `${(err as Error).message}`,
      );
      return null;
    }
    if (!Array.isArray(data?.agents)) {
      this.logger?.warn?.(
        '[inject] /agent-policies 响应形状非法，本轮不刷新受管 agent（保留上次受管块，权限集不变）',
      );
      return null;
    }
    if (data.agents.length === 0) {
      this.logger?.warn?.(
        '[inject] /agent-policies agent 集为空，本轮不刷新受管 agent（保留上次受管块，权限集不变）',
      );
      return null;
    }
    return data;
  }

  /** 注入启用技能（控制面拉取）：GET /skills → 逐个拉 content → applySkills。 */
  async injectSkills(): Promise<string[]> {
    const skills = await this.fetchAll<SkillRecord>('/skills', { enabled: 'true' });
    const resolved: ResolvedSkill[] = [];
    for (const skill of skills) {
      try {
        const content = await this.fetchSkillContent(skill.id);
        if (content === null) {
          this.logger?.warn?.(`[inject] 技能 ${skill.id} content 拉取失败，跳过`);
          continue;
        }
        resolved.push({ name: skill.name, content });
      } catch (err) {
        this.logger?.warn?.(
          `[inject] 技能 ${skill.id}（${skill.name}）注入失败: ${(err as Error).message}`,
        );
      }
    }
    return this.applySkills(resolved);
  }

  /**
   * 本地写入技能（不经控制面）：<workDir>/.opencode/skills/<name>/SKILL.md。
   * 声明式替换——manifest 记录的上次写入、本次不在集合中的技能目录会被删除（传空数组即清空）。
   */
  applySkills(skills: ResolvedSkill[]): string[] {
    const names: string[] = [];
    for (const skill of skills) {
      const skillDir = path.join(this.workDir, '.opencode', 'skills', skill.name);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.content, 'utf8');
      names.push(skill.name);
    }
    this.cleanupByManifest('skills', names);
    return names;
  }

  /** 注入启用工具（控制面拉取）：GET /tools → applyTools。 */
  async injectTools(): Promise<string[]> {
    return (await this.injectToolsDetailed()).actions;
  }

  /**
   * 同 {@link injectTools}，但额外给出**明细**（谁被跳过、为什么）。
   *
   * ⚠️ 明细 + 一条汇总日志是「0 tools」可解释的**唯一**依据：控制面目录里的
   * mcp 型条目（由 `mcp.servers` 承载）、builtin 条目（opencode 原生工具目录项）
   * 都不是"注入失败"；真正要人看的是 `missingExecution`（自定义工具缺执行细节）。
   */
  async injectToolsDetailed(): Promise<{
    actions: string[];
    breakdown: ToolInjectionBreakdown;
  }> {
    const fetched = await this.fetchAll<ToolRecord>('/tools', { enabled: 'true' });
    const result = this.applyToolsDetailed(fetched);
    const b = result.breakdown;
    this.logger?.info?.(
      `[inject] 工具清单：控制面返回 ${b.fetched} 条（enabled=true）→ 渲染为 opencode 工具插件 ` +
        `${b.injected} 条（mcp 型 ${b.mcpType} 条由 mcp 配置节承载、builtin ${b.builtin} 条是 opencode ` +
        `原生工具目录项，均不渲染为插件；缺少执行细节 ${b.missingExecution} 条未渲染）`,
    );
    if (b.fetched === 0) {
      this.logger?.info?.(
        '[inject] 工具清单为空：控制面当前没有启用的工具定义（平台没有可注入的自定义工具）' +
          '——这不是拉取失败（拉取失败会抛错并中止本轮注入）',
      );
    }
    return result;
  }

  /**
   * 本地写入工具（不经控制面）：<workDir>/.opencode/plugins/<action>.ts。
   *
   * T19：v2 已移除 `.opencode/tools/*.ts` 的文件自动发现 ⇒ 工具产物必须落在
   * `.opencode/plugins/`（v1 同样扫描该目录 ⇒ 同一份产物两代通用）。
   * 声明式替换（manifest 记录的上次文件清理）；mcp 型工具跳过（由 mcp-servers 配置节承载）。
   */
  applyTools(tools: ToolRecord[]): string[] {
    return this.applyToolsDetailed(tools).actions;
  }

  /** 同 {@link applyTools}，但额外给出**明细**（拉取条数 / 各类跳过数 / 实际渲染数）。 */
  applyToolsDetailed(tools: ToolRecord[]): {
    actions: string[];
    breakdown: ToolInjectionBreakdown;
  } {
    const writtenFiles: string[] = [];
    const actions: string[] = [];
    const breakdown: ToolInjectionBreakdown = {
      fetched: tools.length,
      mcpType: 0,
      builtin: 0,
      missingExecution: 0,
      injected: 0,
    };
    for (const tool of tools) {
      if (tool.execution === 'mcp') {
        // MCP 工具不渲染为自定义工具文件——由 mcp-servers 配置节注入
        breakdown.mcpType += 1;
        continue;
      }
      const def = this.buildToolDef(tool);
      if (!def) {
        if (tool.source === 'builtin') {
          // builtin 条目 = opencode 原生工具的**目录项**（bash/read/edit/…），
          // 平台只是把它登记成权限点；opencode 自己就有这些工具，
          // 渲染成平台自定义工具插件反而是错的 ⇒ 不算缺口、不告警，只计数。
          breakdown.builtin += 1;
          continue;
        }
        breakdown.missingExecution += 1;
        this.logger?.warn?.(
          `[inject] 工具 ${tool.action} 缺少执行细节（execution=${tool.execution}），跳过注入`,
        );
        continue;
      }
      const fileName = `${def.fileName}.ts`;
      const filePath = path.join(this.workDir, '.opencode', 'plugins', fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, renderCustomToolPlugin(def), 'utf8');
      writtenFiles.push(fileName);
      actions.push(tool.action);
      breakdown.injected += 1;
    }
    this.cleanupByManifest('toolPlugins', writtenFiles);
    this.cleanupByManifest('legacyTools', []);
    return { actions, breakdown };
  }

  /**
   * 写入逐消息 system blob 的**插件交接**产物（D6 候选 (f)）。
   *
   * 落点：`<workDir>/.opencode/plugins/vteam-system-handoff.ts`（v2 的插件发现路径；
   * 必须**项目侧**——serve 跑在隔离配置域里，宿主机的全局插件不在作用域内）。
   *
   * ⚠️ 与工具插件分开记账（manifest 的 `systemHandoffPlugin` 键）：它是**常驻**产物，
   * 不参与"停用资源清理"（`toolPlugins` 的清理会把它删掉）。
   *
   * @returns 写入的文件路径；失败抛错（调用方决定是否阻断启动）。
   */
  applySystemHandoffPlugin(): string {
    const filePath = installSystemHandoffPlugin(this.workDir);
    const manifest = this.readManifest();
    this.writeManifest({ ...manifest, systemHandoffPlugin: SYSTEM_HANDOFF_PLUGIN_FILE });
    return filePath;
  }

  /**
   * 注入 MCP 服务器：<workDir>/opencode.json 的 mcp 节（合并保留其他节）。
   * - 注入启用服务器（local/remote 两型，11 篇 §5.1 格式）
   * - manifest 比对清理：上次注入过、本次不在启用集的条目从 mcp 节移除；
   *   用户手动配置的条目（不在 manifest 中）保留不误删
   * - `agent` 节原样保留（agent 刷新只发生在 `injectMcpAndAgents` 的 injectAll
   *   主链；本方法供注册后 MCP 重注入复用，不触碰 agent 节）
   * 返回注入的服务器名。
   */
  async injectMcp(): Promise<string[]> {
    const servers = await this.fetchAll<McpServerRecord>('/mcp-servers', {
      enabled: 'true',
    });
    return this.applyMcpServers(servers);
  }

  /**
   * 本地写入 MCP 服务器（不经控制面）：只改 opencode.json 的 mcp 节，agent 节原样保留。
   * 声明式替换（manifest 记录的上次 mcp 名清理；用户手写条目保留）。
   */
  applyMcpServers(servers: McpServerRecord[]): string[] {
    const configPath = path.join(this.workDir, 'opencode.json');
    const config = this.readConfig(configPath);
    this.migrateLegacySections(config);
    const manifest = this.readManifest();
    const names = this.mergeMcpSection(config, servers, manifest.mcpServers ?? []);
    this.injectOmoPlugin(config);
    this.disableBuiltinBrowserPlugin(config);
    this.writeConfig(configPath, config);
    this.writeManifest({ ...manifest, mcpServers: names });
    return names;
  }

  /**
   * 本地写入 agent 策略（不经控制面）：只改 opencode.json 的 `agents` 节，mcp 节原样保留。
   * policies=null → 中性化（移除受管 agent 键）；定义非法 → 同样中性化并打 warn
   * （调用方如需 400 语义应先用 buildAgentDefinitions 预校验）。
   *
   * ⚠️ 写出的 `permissions[]` **只覆盖控制面声明的动作**：opencode v2 每个 agent 的内置
   * 规则集以 `{action:"*",resource:"*",effect:"allow"}` 开头、配置规则**追加其后**、
   * 按 `findLast` 求值 ⇒ **未声明**的 action（`webfetch` / `glob` / `grep` / `todowrite` /
   * `skill` / `websearch` 及全部 MCP 工具）在**引擎层放行**（v1 下落到引擎的逐 action
   * ask/deny 默认）。平台已**明确接受**该放宽（**不**补 catch-all ask、**不**加逐 action
   * 默认表；决策见 07 篇 §3.2）——**不要**在这里"顺手"补兜底 ask 规则，那会静默改变
   * 平台已采纳的行为。
   */
  applyAgentPolicies(
    policies: AgentPoliciesResponse | null,
  ): { enabled: boolean; names: string[] } {
    const configPath = path.join(this.workDir, 'opencode.json');
    const config = this.readConfig(configPath);
    this.migrateLegacySections(config);
    const manifest = this.readManifest();
    const mcpNames = manifest.mcpServers ?? [];
    if (policies === null) {
      return this.writeNeutralized(config, configPath, mcpNames).agentPolicies;
    }
    let agentNames: string[];
    try {
      const section = buildAgentDefinitions(policies.agents);
      agentNames = Object.keys(section);
      config[SECTION_AGENTS] = { ...this.readAgentSection(config), ...section };
    } catch (err) {
      this.logger?.warn?.(
        `[inject] agent 定义构造失败，本轮不刷新受管 agent（保留上次受管块，权限集不变）：` +
          `${(err as Error).message}`,
      );
      return this.writeNeutralized(config, configPath, mcpNames).agentPolicies;
    }
    this.cleanupByManifest('agentNames', agentNames, config);
    this.purgeLegacyGuardArtifacts(config);
    this.injectOmoPlugin(config);
    this.disableBuiltinBrowserPlugin(config);
    this.writeConfig(configPath, config);
    return { enabled: true, names: agentNames };
  }

  /**
   * 单写者合并写：`opencode.json` 的 mcp + plugins + agents 三节在同一次
   * read-modify-write 内完成（禁止第二处并行写同一文件）。
   *
   * - `policies` 非空 → `agents` 节 = `buildAgentDefinitions(agents)`（用户手写
   *   agent 键保留）；
   * - `policies` 为 null（拉取失败/agent 集为空）→ **失败中性化**：移除受管 agent
   *   键，报告 `{enabled:false, names:[]}`。
   *
   * 两条路径都会清除已删除的 role-guard 层在持久化卷上的残留（见
   * `purgeLegacyGuardArtifacts`）。
   */
  async injectMcpAndAgents(
    policies: AgentPoliciesResponse | null,
  ): Promise<{ mcpServers: string[]; agentPolicies: { enabled: boolean; names: string[] } }> {
    const servers = await this.fetchAll<McpServerRecord>('/mcp-servers', {
      enabled: 'true',
    });
    return this.applyMcpAndAgents(servers, policies);
  }

  /** 本地写入 MCP + agent 配置（不经控制面）：单次 read-modify-write <workDir>/opencode.json。 */
  async applyMcpAndAgents(
    servers: McpServerRecord[],
    policies: AgentPoliciesResponse | null,
  ): Promise<{ mcpServers: string[]; agentPolicies: { enabled: boolean; names: string[] } }> {
    const configPath = path.join(this.workDir, 'opencode.json');
    const config = this.readConfig(configPath);
    this.migrateLegacySections(config);
    const manifest = this.readManifest();
    const names = this.mergeMcpSection(config, servers, manifest.mcpServers ?? []);

    if (policies === null) {
      return this.writeNeutralized(config, configPath, names);
    }
    let agentNames: string[];
    try {
      const section = buildAgentDefinitions(policies.agents);
      agentNames = Object.keys(section);
      config[SECTION_AGENTS] = { ...this.readAgentSection(config), ...section };
    } catch (err) {
      this.logger?.warn?.(
        `[inject] agent 定义构造失败，本轮不刷新受管 agent（保留上次受管块，权限集不变）：` +
          `${(err as Error).message}`,
      );
      return this.writeNeutralized(config, configPath, names);
    }
    this.cleanupByManifest('agentNames', agentNames, config);

    this.purgeLegacyGuardArtifacts(config);
    this.injectOmoPlugin(config);
    this.disableBuiltinBrowserPlugin(config);
    this.writeConfig(configPath, config);
    return { mcpServers: names, agentPolicies: { enabled: true, names: agentNames } };
  }

  /**
   * 失败中性化写盘（拉取失败 / 角色集为空 / 定义构造失败三入口共用）：
   *
   * ⚠️ **保留上次受管块，不删除**（批次 D-1，2026-10-22）。
   *
   * 改前的行为：中性化 = `cleanupByManifest('agentNames', [], config)` → **删掉**
   * `opencode.json` 里的受管 agent 块 ⇒ agent 退回**引擎默认权限**——那比平台配置的
   * 权限集**更宽** ⇒ 一次控制面抖动（网络失败/形状非法/角色集为空）就**静默放大了**
   * 受管 agent 的权限（fail-open，与本仓「失败即收紧/失败即拒绝」的约定相反）。
   *
   * 改后的行为：**保留**上次成功注入的受管块（内容一字不改）⇒ 权限集**既不收窄也不
   * 放大**（agent 跑在**上次已知**权限集上，陈旧但安全）；manifest 记
   * `agentPoliciesStale: true`（块**未刷新**）并**保留** `agentNames`（块仍在配置里，
   * 记账必须与之一致——清空会让下轮清理把它当垃圾删掉）。
   *
   * 首次注入（无历史受管块）无块可保留：opencode.json 里不写受管定义（= 引擎默认权限，
   * 与改前一致），但必须显式告警说明「没有上次已知权限集可用」。
   *
   * 不抛错：策略拉取失败**不得**中断注入链（skills/tools/mcp 照常注入）。
   */
  private writeNeutralized(
    config: Record<string, unknown>,
    configPath: string,
    mcpNames: string[],
  ): { mcpServers: string[]; agentPolicies: { enabled: boolean; names: string[] } } {
    const manifest = this.readManifest();
    // 受管块名字**不清零**：块仍在 opencode.json 里（未删除、未改写）。
    const preserved = manifest.agentNames ?? [];
    this.purgeLegacyGuardArtifacts(config);
    this.writeManifest({
      // ⚠️ 读**purge 之后**的 manifest：purge 会删掉 guardRolesFile 等历史键，
      // 用 purge 之前的快照回写会把它们复活（改前也是 purge 后再读）。
      ...this.readManifest(),
      mcpServers: mcpNames,
      agentNames: preserved,
      agentPoliciesStale: true,
    });
    this.injectOmoPlugin(config);
    this.disableBuiltinBrowserPlugin(config);
    this.writeConfig(configPath, config);
    if (preserved.length > 0) {
      this.logger?.warn?.(
        `[inject] agent 策略未刷新（拉取失败/形状非法/角色集为空）→ **保留**上次注入的受管块` +
          `（${preserved.join(', ')}，内容未改写）：agent 正运行在**上次已知**权限集上` +
          '（权限既未收窄也未放大）。若控制面长时间不可用，该权限集可能已过期，请人工确认。',
      );
    } else {
      this.logger?.warn?.(
        '[inject] agent 策略未刷新（拉取失败/形状非法/角色集为空）→ **无历史受管块可保留**' +
          '（首次注入/上一轮本就无受管块）：opencode.json 未写入受管 agent 定义，' +
          'agent 将使用**引擎默认权限**（比平台配置的权限集更宽）——' +
          '首次注入前请确保控制面可达。',
      );
    }
    return { mcpServers: mcpNames, agentPolicies: { enabled: false, names: [] } };
  }

  /**
   * 清除已删除的 role-guard 层在持久化卷上的残留（一次性迁移清理，两条注入路径都走）。
   *
   * 旧版本会写 `<workDir>/.vteam-role-guard/{roles.json,sessions/}` 并把
   * `./.opencode/plugin/vteam-role-guard.ts` 注册进 `opencode.json` 的 `plugin`
   * 数组。卷是持久的、镜像不是——不清理的话，删掉源码后 serve 仍会从旧卷加载那个
   * 插件模块并 fail-close 全部工具调用。只删本注入器写过的路径/条目，用户手写
   * plugin 条目与用户文件不动。
   */
  private purgeLegacyGuardArtifacts(config: Record<string, unknown>): void {
    for (const rel of ['.vteam-role-guard', '.opencode/plugin/vteam-role-guard.ts']) {
      fs.rmSync(path.join(this.workDir, rel), { recursive: true, force: true });
    }
    // T15：插件条目在 v2 的 `plugins` 段（v1 段名 `plugin` 已被迁移走）。
    if (Array.isArray(config[SECTION_PLUGINS])) {
      const filtered = (config[SECTION_PLUGINS] as unknown[]).filter(
        (entry) => !(typeof entry === 'string' && LEGACY_GUARD_ENTRY_RE.test(entry)),
      );
      if (filtered.length !== (config[SECTION_PLUGINS] as unknown[]).length) {
        config[SECTION_PLUGINS] = filtered;
      }
    }
    const manifest = this.readManifest() as Record<string, unknown>;
    const staleKeys = ['guardRolesFile', 'guardSessionsDir', 'guardPluginFile'];
    const present = staleKeys.filter((key) => key in manifest);
    if (present.length > 0) {
      for (const key of present) {
        delete manifest[key];
      }
      this.writeManifest(manifest as InjectManifest);
    }
  }

  /**
   * T15：**v1 段名 → v2 段名**的一次性迁移（每次写盘前都跑，幂等）。
   *
   * 背景：`<workDir>/opencode.json` 在**持久卷**上（镜像不是）⇒ 升级后 v1 段名会一直留在
   * 文件里。而 v2 遇到「v1 段 + v2 段并存」时的行为是**静默归一化**（可能产生归一化诊断
   * WARN）；更致命的是 v2 原生 `agents:` 节里的 `prompt` 键**静默丢弃**（角色提示全丢）。
   * ⇒ 旧形态必须被**迁走**，不能与新形态并存。
   *
   * 迁移内容：
   * - `agent:` → `agents:`（同名以 v2 节为准；条目内 v1 `permission` 对象 → `permissions[]`、
   *   v1 `prompt` → **v2 `system`**）；
   * - `plugin:` 数组 → `plugins:` 数组（字符串条目去重）；
   * - `mcp:` 扁平形 → `mcp.servers.<name>`（条目内 `enabled` → `disabled`（**极性相反**）、
   *   单值 `timeout` → **三段**、OAuth camelCase → snake_case）。
   */
  private migrateLegacySections(config: Record<string, unknown>): void {
    this.migrateLegacyAgentSection(config);
    this.migrateLegacyPluginSection(config);
    this.migrateLegacyMcpSection(config);
  }

  /** v1 `agent:` 节 → v2 `agents:` 节（同名以 v2 节为准）。 */
  private migrateLegacyAgentSection(config: Record<string, unknown>): void {
    const legacy = config[SECTION_AGENT_LEGACY];
    const current = config[SECTION_AGENTS];
    if (legacy === undefined && current === undefined) {
      return;
    }
    const merged: Record<string, unknown> = {};
    if (isPlainObject(legacy)) {
      for (const [name, entry] of Object.entries(legacy)) {
        merged[name] = this.normalizeAgentEntryToV2(name, entry);
      }
    }
    if (isPlainObject(current)) {
      for (const [name, entry] of Object.entries(current)) {
        merged[name] = this.normalizeAgentEntryToV2(name, entry);
      }
    }
    config[SECTION_AGENTS] = merged;
    delete config[SECTION_AGENT_LEGACY];
  }

  /**
   * agent 条目 → v2 原生形状（幂等；用户手写条目与受管条目同口径）。
   *
   * - v1 `permission`（对象）→ v2 `permissions[]`（**与受管 agent 同一套**翻译函数）；
   *   翻译失败 → **保留原键**并告警（不静默丢规则；v2 不认它，人工可修）；
   * - v1 `prompt` → v2 **`system`**（⚠️ 这是"静默丢弃"陷阱的兜底：即便有人手写了
   *   `agents.<n>.prompt`，注入器也把它搬进 `system`，角色提示不会丢）；
   * - v1 `maxSteps` → `steps`、`disable` → `disabled`。
   */
  private normalizeAgentEntryToV2(name: string, entry: unknown): unknown {
    if (!isPlainObject(entry)) {
      return entry;
    }
    const out: Record<string, unknown> = { ...entry };
    if (Object.prototype.hasOwnProperty.call(out, 'permission')) {
      const raw = out['permission'];
      try {
        out['permissions'] = buildPermissionRules(
          isPlainObject(raw) ? raw : {},
          `agent ${name} permission`,
        );
        delete out['permission'];
      } catch (err) {
        this.logger?.warn?.(
          `[inject] agent ${name} 的 v1 permission 无法翻成 v2 permissions[]：` +
            `${(err as Error).message}（原键保留，v2 不识别它，需人工修正）`,
        );
      }
    }
    if (Object.prototype.hasOwnProperty.call(out, 'prompt')) {
      const prompt = out['prompt'];
      delete out['prompt'];
      if (typeof prompt === 'string' && prompt.trim() !== '' && out['system'] === undefined) {
        out['system'] = prompt;
      }
    }
    if (Object.prototype.hasOwnProperty.call(out, 'maxSteps') && out['steps'] === undefined) {
      out['steps'] = out['maxSteps'];
      delete out['maxSteps'];
    }
    if (Object.prototype.hasOwnProperty.call(out, 'disable') && out['disabled'] === undefined) {
      out['disabled'] = out['disable'];
      delete out['disable'];
    }
    return out;
  }

  /** v1 `plugin:` 数组 → v2 `plugins:` 数组（字符串条目去重，顺序保留）。 */
  private migrateLegacyPluginSection(config: Record<string, unknown>): void {
    const legacy = config[SECTION_PLUGIN_LEGACY];
    const current = config[SECTION_PLUGINS];
    if (legacy === undefined && current === undefined) {
      return;
    }
    const merged: unknown[] = [];
    if (Array.isArray(legacy)) {
      merged.push(...legacy);
    }
    if (Array.isArray(current)) {
      merged.push(...current);
    }
    const seen = new Set<string>();
    const deduped: unknown[] = [];
    for (const entry of merged) {
      if (typeof entry === 'string') {
        if (seen.has(entry)) {
          continue;
        }
        seen.add(entry);
      }
      deduped.push(entry);
    }
    config[SECTION_PLUGINS] = deduped;
    delete config[SECTION_PLUGIN_LEGACY];
  }

  /** v1 扁平 `mcp:` → v2 `mcp.servers.<name>`（顶层 `timeout` 仍是 v2 的默认超时键）。 */
  private migrateLegacyMcpSection(config: Record<string, unknown>): void {
    const raw = config[SECTION_MCP];
    if (raw === undefined) {
      return;
    }
    if (!isPlainObject(raw)) {
      delete config[SECTION_MCP];
      return;
    }
    const servers: Record<string, unknown> = {};
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'servers') {
        if (isPlainObject(value)) {
          for (const [name, entry] of Object.entries(value)) {
            servers[name] = this.normalizeMcpEntryToV2(name, entry);
          }
        }
        continue;
      }
      if (key === 'timeout') {
        // v2 顶层默认超时（**不是**服务器条目）：v1 单值 → v2 三段
        rest.timeout = typeof value === 'number' ? buildMcpTimeout(value) : value;
        continue;
      }
      // v1 扁平形：其余键都是服务器条目
      servers[key] = this.normalizeMcpEntryToV2(key, value);
    }
    config[SECTION_MCP] = { ...rest, servers };
  }

  /**
   * MCP 条目 → v2 原生形状（幂等）。
   *
   * - v1 `enabled:true` → v2 `disabled:false`（**极性相反**：v2 用 `disabled` 表达"停用"）；
   * - v1 单值 `timeout:<ms>` → v2 **三段** `{startup, catalog, execution}`（单值归一化会
   *   **丢 `startup` 段**）；
   * - OAuth 字段 camelCase → **snake_case**（v2 认不出 camelCase）。
   */
  private normalizeMcpEntryToV2(name: string, entry: unknown): unknown {
    if (!isPlainObject(entry)) {
      return entry;
    }
    const out: Record<string, unknown> = { ...entry };
    if (
      Object.prototype.hasOwnProperty.call(out, 'enabled') &&
      !Object.prototype.hasOwnProperty.call(out, 'disabled')
    ) {
      out['disabled'] = out['enabled'] !== true;
      delete out['enabled'];
    }
    if (typeof out['timeout'] === 'number') {
      out['timeout'] = buildMcpTimeout(out['timeout']);
    }
    const oauth = out['oauth'];
    if (oauth !== undefined && oauth !== null) {
      const normalized = normalizeMcpOAuth(oauth);
      if (normalized) {
        out['oauth'] = normalized;
      } else {
        delete out['oauth'];
      }
    }
    return out;
  }

  /**
   * mcp 节合并（注入器管理域清理 + 用户手动条目保留），返回本次启用名。
   *
   * 写出的是 **v2 原生形**：`config.mcp.servers.<name>`（服务器条目在 `servers` 下）。
   */
  private mergeMcpSection(
    config: Record<string, unknown>,
    servers: McpServerRecord[],
    previouslyInjected: string[],
  ): string[] {
    const root = isPlainObject(config[SECTION_MCP])
      ? (config[SECTION_MCP] as Record<string, unknown>)
      : {};
    const existing = isPlainObject(root['servers'])
      ? (root['servers'] as Record<string, unknown>)
      : {};
    const merged: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(existing)) {
      if (!previouslyInjected.includes(name)) {
        // 用户手写条目保留（形状已在迁移阶段归一到 v2）
        merged[name] = entry;
      }
    }
    const names: string[] = [];
    for (const server of servers) {
      const entry = this.buildMcpEntry(server);
      if (!entry) {
        this.logger?.warn?.(
          `[inject] MCP 服务器 ${server.name} 配置不完整（type=${server.type}），跳过`,
        );
        continue;
      }
      merged[server.name] = entry;
      names.push(server.name);
    }
    config[SECTION_MCP] = { ...root, servers: merged };
    return names;
  }

  /**
   * 声明 OmO（oh-my-openagent）到 opencode.json 的 **`plugins` 节**（v2 原生段名）。
   *
   * 插件由**官方安装器在镜像构建期**注册（见 Dockerfile：`bunx oh-my-openagent install
   * --no-tui --platform=opencode --skip-auth`），它会把条目写进 $HOME/.config/opencode/
   * opencode.json。但 opencode 运行时的 cwd 是 <workDir>（/data/vteam-worker），读的是
   * <workDir>/opencode.json——两份配置不是同一个文件，所以这里必须把插件条目同步进来，
   * 否则 serve 根本不会加载 OmO。
   *
   * 合并策略（与 mcp 节同思路，幂等）：
   * - 已存在指向 OmO 的条目（任意写法：包名 / @latest / 路径）→ 不重复追加；
   * - 用户手写的其他 plugin 条目一律保留。
   *
   * ⚠️ **注册是有条件的**（`resolveOmoRegistration`）：v1 形态的插件实现在 v2 不会运行，
   * 而镜像内置的 OmO 正是 v1 形态 ⇒ 在 v2 上注册它只会让 serve 静默地加载失败
   * （`plugins` 是合法键 ⇒ **不产生**归一化诊断 ⇒ 那个闸门查不到）。
   * 故：用户开关关闭、或镜像声明内置 OmO 只有 v1 形态时，**不注册**，并清掉
   * 持久卷上历史遗留的 OmO 条目（升级路径必须清，否则老条目会一直留在配置里）。
   */
  private injectOmoPlugin(config: Record<string, unknown>): void {
    const raw = Array.isArray(config[SECTION_PLUGINS])
      ? (config[SECTION_PLUGINS] as unknown[]).slice()
      : [];
    // 迁移清理：移除历史误装的 slim fork 条目（与 OmO 不是同一个插件）
    const existing = raw.filter(
      (entry) => !(typeof entry === 'string' && OMO_SLIM_ENTRY_RE.test(entry)),
    );
    if (!this.resolveOmoRegistration()) {
      const kept = existing.filter(
        (entry) => !(typeof entry === 'string' && OMO_ENTRY_RE.test(entry)),
      );
      if (kept.length !== existing.length) {
        this.logger?.warn?.(
          '[inject] 已从 opencode.json 的 plugins 节移除 OmO 条目（v2 不会加载 v1 形态插件，' +
            '留着只会静默失败）',
        );
      }
      config[SECTION_PLUGINS] = kept;
      return;
    }
    const already = existing.some(
      (entry) => typeof entry === 'string' && OMO_ENTRY_RE.test(entry),
    );
    if (!already) {
      existing.push(OMO_PLUGIN_ENTRY);
    }
    config[SECTION_PLUGINS] = existing;
  }

  /**
   * 是否应当注册 OmO 插件条目（两个条件都要满足）。
   *
   * ① **用户开关**：`<workDir>/.omo/omo-enabled.json`（缺省 true）。此前该开关**完全
   *    不影响配置**——关掉它只是让 serve 少拼一个 `--pure`（v2 已无此 flag ⇒ 早已失效），
   *    配置里的 OmO 条目照写 ⇒ 开关"看得见、不生效"。现在它**直接决定配置**。
   * ② **镜像能力标记**：`/opt/omo-bundled.json` 的 `v2` 字段（true=有 v2 形态入口 /
   *    false=只有 v1 形态 / 缺失=未知）。false ⇒ 不注册（v2 加载不了）；缺失 ⇒ 保持
   *    既有行为并告警。
   */
  private resolveOmoRegistration(): boolean {
    if (!readOmoEnabled(this.workDir)) {
      return false;
    }
    const capability = this.bundledOmoV2Capability();
    if (capability === false) {
      this.logger?.info?.(
        '[inject] 不注册 OmO：镜像内置的 OmO 只有 v1 形态入口（{server}），' +
          'opencode v2 只加载 v2 形态（{id, setup}）⇒ 注册了也只会静默失败。' +
          '（v2 线按「OmO 关闭」上线，见 docs/deployment.md §8.5）',
      );
      return false;
    }
    if (capability === null) {
      this.logger?.warn?.(
        `[inject] 内置 OmO 是否具备 v2 形态入口未知（${OMO_BUNDLED_MARKER} 缺少 ` +
          `"${OMO_BUNDLED_V2_CAPABILITY_FIELD}" 字段）→ 按既有行为注册 OmO 条目；` +
          '若该 OmO 是 v1 形态，它在 v2 上不会加载（静默失败）',
      );
    }
    return true;
  }

  /**
   * 读镜像能力标记：`/opt/omo-bundled.json` 的 `v2` 字段。
   *
   * @returns true=有 v2 形态入口 / false=只有 v1 形态 / null=未知（文件不存在或字段缺失）
   */
  private bundledOmoV2Capability(): boolean | null {
    try {
      const raw = JSON.parse(fs.readFileSync(OMO_BUNDLED_MARKER, 'utf8')) as {
        [OMO_BUNDLED_V2_CAPABILITY_FIELD]?: unknown;
      };
      const value = raw?.[OMO_BUNDLED_V2_CAPABILITY_FIELD];
      if (typeof value === 'boolean') {
        return value;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 禁用 v2 内置浏览器插件（**必须**：它占着 `browser` 这个工具名，会静默遮蔽平台自己的
   * browser 工具——工具进了全局注册表，但模型的 `tools[]` 里没有它，模型永远调不到，
   * 且**全程无报错**）。
   *
   * 实测（opencode v2.0.28）：内置插件 id = `opencode.browser`；项目 `opencode.json` 的
   * `plugins` 节加 `"-opencode.browser"` 后，平台的 `browser` 工具正常出现在 `tools[]`。
   * 精确 id 禁用是 T6 唯一验证过的安全手段（`["-*"]` 会把内置 agent/provider 一起关掉）。
   *
   * 与 `injectOmoPlugin` 同一入口（两者都写 `plugins` 节，单写者）。
   */
  private disableBuiltinBrowserPlugin(config: Record<string, unknown>): void {
    const raw = Array.isArray(config[SECTION_PLUGINS])
      ? (config[SECTION_PLUGINS] as unknown[]).slice()
      : [];
    if (!raw.includes(DISABLE_BUILTIN_BROWSER_ENTRY)) {
      raw.push(DISABLE_BUILTIN_BROWSER_ENTRY);
    }
    config[SECTION_PLUGINS] = raw;
  }

  /** 写入 OmO 的 agent→模型配置（委托 omo-config 模块，与 exec-server 共用同一实现）。 */
  async writeOmoConfig(agents: Record<string, string>): Promise<string> {
    return writeOmoAgents(this.workDir, agents);
  }

  /** 读取 OmO 的 agent→模型配置（扁平 name→model）。 */
  readOmoConfig(): Record<string, string> {
    return readOmoAgents(this.workDir);
  }

  // ------------------------------------------------------------------
  // 私有：控制面拉取
  // ------------------------------------------------------------------

  private async getJson<T>(pathname: string, query: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(query).toString();
    const url = apiUrl(this.serverUrl, `${pathname}?${qs}`);
    const response = await this.fetchImpl(url, {
      headers: {
        [WORKER_TOKEN_HEADER]: this.workerToken,
        // 携带 worker 身份：server 按 worker.capabilities.mcpUrl 覆盖内置 vteam 地址
        'x-worker-id': this.workerId,
      },
    });
    if (!response.ok) {
      throw new Error(
        `资源拉取失败: HTTP ${response.status} ${response.statusText} (${pathname})`,
      );
    }
    return (await response.json()) as T;
  }

  /** 分页拉取全部记录（pageSize=100 循环至 total）。 */
  private async fetchAll<T>(pathname: string, query: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const data = await this.getJson<{ items: T[]; total: number }>(pathname, {
        ...query,
        page: String(page),
        pageSize: String(DEFAULT_PAGE_SIZE),
      });
      items.push(...data.items);
      if (data.items.length === 0 || page * DEFAULT_PAGE_SIZE >= data.total) {
        break;
      }
    }
    return items;
  }

  /** GET /skills/:id/content → SKILL.md 全文；404/失败返回 null（调用方跳过）。 */
  private async fetchSkillContent(id: string): Promise<string | null> {
    const response = await this.fetchImpl(
      apiUrl(this.serverUrl, `/skills/${encodeURIComponent(id)}/content`),
      { headers: { [WORKER_TOKEN_HEADER]: this.workerToken } },
    );
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { content?: unknown };
    return typeof data.content === 'string' ? data.content : null;
  }

  // ------------------------------------------------------------------
  // 私有：tools 定义构造
  // ------------------------------------------------------------------

  /** 从 DB tool 记录构造渲染定义；执行细节缺失返回 null（调用方跳过）。 */
  private buildToolDef(tool: ToolRecord): CustomToolFileDef | null {
    const execute = this.resolveExecution(tool);
    if (!execute) {
      return null;
    }
    return {
      fileName: this.sanitizeFileName(tool.action),
      exports: [
        {
          // 默认导出：工具名 = 文件名 = action（FR-48 工具名即权限 action）
          exportName: 'default',
          description: tool.name || tool.action,
          args: schemaToArgs(tool.schema),
          execute,
        },
      ],
    };
  }

  /**
   * 解析 execution 渲染源。优先读取输入 schema 的约定扩展字段 `x-execution`
   * （`{command?|url/method/headers?|code}`，由工具注册侧写入）；缺失时返回 null
   * → 调用方跳过注入（未配置完整执行细节的工具不暴露给模型）。
   */
  private resolveExecution(
    tool: ToolRecord,
  ): CustomToolFileDef['exports'][number]['execute'] | null {
    const xExec = readXExecution(tool.schema);

    switch (tool.execution) {
      case 'cli': {
        const command =
          xExec && Array.isArray(xExec.command) && xExec.command.length > 0
            ? xExec.command.map(String)
            : undefined;
        if (!command) {
          return null;
        }
        return { type: 'cli', command };
      }
      case 'http': {
        const url = xExec && typeof xExec.url === 'string' ? xExec.url : undefined;
        if (!url) {
          return null;
        }
        const method =
          xExec && typeof xExec.method === 'string' ? xExec.method.toUpperCase() : 'POST';
        const headers =
          xExec && typeof xExec.headers === 'object' && xExec.headers !== null
            ? (xExec.headers as Record<string, string>)
            : undefined;
        return { type: 'http', url, method, headers };
      }
      case 'code': {
        const code = xExec && typeof xExec.code === 'string' ? xExec.code : undefined;
        if (!code) {
          return null;
        }
        return { type: 'code', code };
      }
      default:
        // 未知 execution（非 code/cli/http/mcp）不渲染
        return null;
    }
  }

  private sanitizeFileName(action: string): string {
    const cleaned = action.replace(INVALID_FILE_CHARS, '-').replace(/^\.+|\.+$/g, '');
    return cleaned || 'tool';
  }

  // ------------------------------------------------------------------
  // 私有：MCP 配置节构造
  // ------------------------------------------------------------------

  /**
   * 按 local/remote 构造 opencode **v2 原生** MCP 条目（`mcp.servers.<name>`）。
   *
   * v2 形（实测 opencode v2.0.28 `Mcp.LocalConfigEncoded` / `Mcp.RemoteConfigEncoded`）：
   * - `type` + `command: string[]`（**数组**）/ `cwd` / `environment`；
   * - `disabled: boolean`（v1 的 `enabled` **极性相反**：`enabled:true` → `disabled:false`）；
   * - `timeout: {startup, catalog, execution}`（v1 单值 ms **会丢 `startup` 段** ⇒ 显式写三段）；
   * - OAuth 字段是 **snake_case**（`client_id` / `client_secret` / `callback_port` /
   *   `redirect_uri` / `scope` / `auth_server_metadata_url`）。
   *
   * 配置不完整返回 null（调用方跳过该服务器）。
   */
  private buildMcpEntry(server: McpServerRecord): Record<string, unknown> | null {
    if (server.type === 'local') {
      const command = server.command?.command;
      if (!Array.isArray(command) || command.length === 0) {
        return null;
      }
      const entry: Record<string, unknown> = { type: 'local', command };
      if (server.command?.cwd) entry.cwd = server.command.cwd;
      if (server.command?.environment) entry.environment = server.command.environment;
      const timeout = server.command?.timeout;
      if (typeof timeout === 'number' && timeout > 0) {
        entry.timeout = buildMcpTimeout(timeout);
      }
      entry.disabled = server.enabled === false;
      return entry;
    }
    if (server.type === 'remote') {
      if (!server.url) {
        return null;
      }
      const entry: Record<string, unknown> = { type: 'remote', url: server.url };
      if (server.headers) entry.headers = this.resolveHeaders(server.headers);
      if (server.oauth !== undefined && server.oauth !== null) {
        const oauth = normalizeMcpOAuth(server.oauth);
        if (oauth) {
          entry.oauth = oauth;
        }
      }
      const timeout =
        server.name === VTEAM_MCP_SERVER_NAME
          ? resolveVteamMcpTimeoutMs()
          : typeof server.timeout === 'number' && server.timeout > 0
            ? server.timeout
            : undefined;
      if (timeout !== undefined) {
        entry.timeout = buildMcpTimeout(timeout);
      }
      entry.disabled = server.enabled === false;
      return entry;
    }
    return null;
  }

  /**
   * 解析 headers 中的 {env:VAR} 模板为实际值（worker 侧已知 WORKER_ID / X_WORKER_TOKEN
   * 直接替换，不依赖 serve 子进程环境是否导出、以及 opencode 版本对 {env:} 模板的
   * 支持差异——外部 worker 场景 serve 环境缺变量时模板替换为空导致 401 needs_auth）。
   * 未知变量保留原样（由 opencode 侧兜底替换）。
   */
  private resolveHeaders(
    headers: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!headers) {
      return headers;
    }
    const knownEnv: Record<string, string> = {
      WORKER_ID: this.workerId,
      X_WORKER_TOKEN: this.workerToken,
    };
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(headers)) {
      resolved[key] =
        typeof value === 'string'
          ? value.replace(/\{env:([A-Z0-9_]+)\}/g, (match, name: string) => knownEnv[name] ?? match)
          : value;
    }
    return resolved;
  }

  // ------------------------------------------------------------------
  // 私有：opencode.json 与 manifest 读写
  // ------------------------------------------------------------------

  private readConfig(configPath: string): Record<string, unknown> {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // 不存在或非法 JSON：从空配置合并
      return {};
    }
  }

  /** 读取配置的 v2 `agents` 节（非对象/数组时返回空对象；用户手写键一并返回）。 */
  private readAgentSection(config: Record<string, unknown>): Record<string, unknown> {
    const agents = config[SECTION_AGENTS];
    return isPlainObject(agents) ? (agents as Record<string, unknown>) : {};
  }

  private writeConfig(configPath: string, config: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  private readManifest(): InjectManifest {
    try {
      const raw = fs.readFileSync(this.manifestPath(), 'utf8');
      const parsed = JSON.parse(raw) as InjectManifest;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private writeManifest(manifest: InjectManifest): void {
    fs.writeFileSync(this.manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  private manifestPath(): string {
    return path.join(this.workDir, MANIFEST_REL);
  }

  /**
   * 停用资源清理：各 manifest 键走显式分支，绝不混用——
   * - `skills` → 删目录（`.opencode/skills/<name>`）；
   * - `toolPlugins` → 删文件（`.opencode/plugins/<file>`，T19 起的工具产物落点）；
   * - `legacyTools` → 删文件（`.opencode/tools/<file>`，升级前的 v1 形态残留；一次性清空，
   *   同时删掉升级前的旧 manifest 键 `tools`）；
   * - `agentNames` → 重写内存中 `config.agents`，删除受管（上次注入）且不在本次
   *   集合的 agent 键（用户手写键保留；删空后移除 `agents` 节；调用方统一落盘，
   *   保持 `opencode.json` 单写者）。
   */
  private cleanupByManifest(
    kind: 'skills' | 'toolPlugins' | 'legacyTools',
    current: string[],
  ): void;
  private cleanupByManifest(
    kind: 'agentNames',
    current: string[],
    config: Record<string, unknown>,
  ): void;
  private cleanupByManifest(
    kind: 'skills' | 'toolPlugins' | 'legacyTools' | 'agentNames',
    current: string[],
    config?: Record<string, unknown>,
  ): void {
    const manifest = this.readManifest();
    if (kind === 'skills' || kind === 'toolPlugins' || kind === 'legacyTools') {
      const names = current as string[];
      const previous: string[] =
        kind === 'skills'
          ? (manifest.skills ?? [])
          : kind === 'toolPlugins'
            ? (manifest.toolPlugins ?? [])
            : [...(manifest.legacyTools ?? []), ...(manifest.tools ?? [])];
      const removed = previous.filter((p) => !names.includes(p));
      if (removed.length > 0) {
        if (kind === 'skills') {
          for (const name of removed) {
            fs.rmSync(path.join(this.workDir, '.opencode', 'skills', name), {
              recursive: true,
              force: true,
            });
          }
        } else if (kind === 'toolPlugins') {
          for (const file of removed) {
            fs.rmSync(path.join(this.workDir, '.opencode', 'plugins', file), { force: true });
          }
        } else {
          for (const file of removed) {
            fs.rmSync(path.join(this.workDir, '.opencode', 'tools', file), { force: true });
          }
        }
      }
      if (kind === 'legacyTools') {
        const next: InjectManifest = { ...manifest, legacyTools: names };
        delete next.tools;
        this.writeManifest(next);
        return;
      }
      this.writeManifest({ ...manifest, [kind]: names });
      return;
    }
    if (!config) {
      throw new Error('[inject] cleanupByManifest(agentNames) 缺少 opencode 配置对象');
    }
    const names = current as string[];
    const previous = manifest.agentNames ?? [];
    const removed = previous.filter((n) => !names.includes(n));
    if (removed.length > 0) {
      const agents = this.readAgentSection(config);
      for (const name of removed) {
        delete agents[name];
      }
      if (Object.keys(agents).length === 0) {
        delete config[SECTION_AGENTS];
      } else {
        config[SECTION_AGENTS] = agents;
      }
    }
    // 成功注入 ⇒ 受管块已刷新 ⇒ 清掉中性化期间记的「未刷新」标记（否则标记会撒谎）。
    this.writeManifest({ ...manifest, agentNames: names, agentPoliciesStale: false });
  }
}

// ------------------------------------------------------------------
// 模块级工具函数（导出供 spec 断言）
// ------------------------------------------------------------------

/** 普通对象判定（非数组、非 null）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * T15：MCP OAuth 配置 → **v2 snake_case** 形状。
 *
 * v2 的 OAuth 对象 `additionalProperties:false`（只认 `client_id` / `client_secret` /
 * `scope` / `callback_port` / `redirect_uri` / `auth_server_metadata_url`）⇒ v1 的 camelCase
 * 会被**忽略**。`callback_port` 还必须是 1–65535 的整数（v2 约束）——非法值丢弃。
 *
 * 归一后为空 → 返回 null（调用方不写 `oauth` 键）。
 */
export function normalizeMcpOAuth(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = MCP_OAUTH_FIELD_RENAMES[key] ?? key;
    if (target === 'callback_port') {
      const port = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        continue;
      }
      out[target] = port;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[target] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 从输入 schema 提取约定执行细节扩展字段（x-execution）。 */
export function readXExecution(
  schema: Record<string, unknown> | null | undefined,
): { command?: unknown; url?: unknown; method?: unknown; headers?: unknown; code?: unknown } | null {
  if (!schema || typeof schema !== 'object') {
    return null;
  }
  const x = schema['x-execution'];
  return x && typeof x === 'object' ? (x as Record<string, unknown>) : null;
}

/** JSON Schema（properties + required）→ CustomToolArg[]。 */
export function schemaToArgs(
  schema: Record<string, unknown> | null | undefined,
): CustomToolArg[] {
  if (!schema || typeof schema !== 'object') {
    return [];
  }
  const properties = schema.properties as
    | Record<string, { type?: unknown; description?: unknown }>
    | undefined;
  if (!properties || typeof properties !== 'object') {
    return [];
  }
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  return Object.entries(properties).map(([name, prop]) => {
    const p = prop && typeof prop === 'object' ? prop : {};
    const rawType = typeof p.type === 'string' ? p.type : 'string';
    const type: CustomToolArgType =
      rawType === 'boolean'
        ? 'boolean'
        : rawType === 'integer' || rawType === 'number'
          ? 'integer'
          : 'string';
    return {
      name,
      type,
      required: required.includes(name),
      description: typeof p.description === 'string' ? p.description : '',
    };
  });
}
