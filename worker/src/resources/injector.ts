/**
 * T4b 资源注入执行器：worker 从控制面拉取三类资源并注入本地 opencode 配置目录。
 *
 * - injectSkills()：GET /skills（enabled=true）→ 逐个 GET /skills/:id/content →
 *   写 <workDir>/.opencode/skills/<name>/SKILL.md（serve 启动时 discoverSkills 扫描）
 * - injectTools()：GET /tools（enabled=true）→ 渲染 renderCustomToolFile →
 *   写 <workDir>/.opencode/tools/<action>.ts（默认导出，工具名 = action = 权限点 FR-48）
 * - injectMcp()：GET /mcp-servers（enabled=true）→ 生成 <workDir>/opencode.json 的
 *   mcp 节（合并保留其他配置节，11 篇 §5.1 格式）
 * - injectAll()：三者组合，供 T4a 命令回调与 worker 启动前调用
 *
 * 鉴权：所有拉取带 X-Worker-Token（与注册/心跳同 token，对齐 server WorkerOrJwtGuard）。
 * 清理：停用资源的残留文件经 manifest（<workDir>/.opencode-worker-inject.json）比对后
 * 删除——只删本注入器写过的文件，不误伤 git.ts（内置注入）与用户文件。
 *
 * worker 独立进程铁律：不 import server 代码（apiUrl/WORKER_TOKEN_HEADER 复用 registry-client 常量）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { apiUrl, WORKER_TOKEN_HEADER } from '../client/registry-client';
import { readOmoAgents, writeOmoAgents } from './omo-config';
import {
  AgentPoliciesResponse,
  buildAgentDefinitions,
} from './opencode-config-builder';
import { renderRoleGuardPlugin } from './role-guard-plugin';
import {
  CustomToolArg,
  CustomToolArgType,
  CustomToolFileDef,
  renderCustomToolFile,
} from './custom-tool';

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
  mcpServers: string[];
  /**
   * agent 策略注入结果（Todo 14 上报能力位的成功/报告信号）：
   * - 成功（`/agent-policies` 拉取成功且角色集非空）→ `{ enabled: true, names: 本次写入名 }`；
   * - 失败中性化（拉取失败或角色集为空）→ `{ enabled: false, names: [] }`。
   */
  agentPolicies: { enabled: boolean; names: string[] };
}

/** 控制面资源记录最小形态（来自 GET /skills、/tools、/mcp-servers）。 */
interface SkillRecord {
  id: string;
  name: string;
}
interface ToolRecord {
  id: string;
  action: string;
  name: string;
  execution: string;
  schema: Record<string, unknown> | null;
}
interface McpServerRecord {
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
  tools?: string[];
  mcpServers?: string[];
  /**
   * 上次写入 opencode.json `agent` 节的受管 agent 名（仅注入器写入的名；用户手写
   * 的 agent 键不在此列，清理时保留）。
   */
  agentNames?: string[];
  /** guard 制品相对路径（相对 workDir；null = 未管理/已清理）。 */
  guardRolesFile?: string | null;
  guardSessionsDir?: string | null;
  /**
   * guard 插件文件相对路径。Todo 15 建键 + 清理分支；Todo 18 起成功路径写入
   * 插件体（`writeGuardPluginFile`）并注册 `plugin` 条目（`ensureGuardPluginEntry`），
   * 本键同步更新为正典路径；中性化/停用路径仍走清理（删文件 + 移除条目）。
   */
  guardPluginFile?: string | null;
}

const MANIFEST_REL = '.opencode-worker-inject.json';
const DEFAULT_PAGE_SIZE = 100;
/** tools 注入文件名非法字符（opencode 工具名约束，安全兜底）。 */
const INVALID_FILE_CHARS = /[^a-z0-9-_.]/g;

/**
 * guard 制品路径（单一路径方案，相对 workDir）：
 * - roles.json：guard 判定唯一数据源 `{ enabled, roles }`；
 * - sessions/：session→agent 映射目录（Todo 19 写入 `<sessionId>.json`）。
 */
const ROLE_GUARD_DIR_REL = '.vteam-role-guard';
const ROLE_GUARD_ROLES_REL = `${ROLE_GUARD_DIR_REL}/roles.json`;
const ROLE_GUARD_SESSIONS_REL = `${ROLE_GUARD_DIR_REL}/sessions`;
  /**
   * guard 插件文件相对路径（`<workDir>/.opencode/plugin/vteam-role-guard.ts`）。
   *
   * 职责拆分（Todo 15 vs Todo 18）：Todo 15 建 manifest `guardPluginFile` 键 +
   * 清理分支；**Todo 18 完成插件体写入（`renderRoleGuardPlugin()`）+ `plugin`
   * 数组注册（`ensureGuardPluginEntry`），见 `injectMcpAndAgents` 成功路径**。
   * 成功路径故意保留 manifest 键的显式管理（陈旧异路径文件删除 + 键更新），
   * 中性化/停用路径沿用清理分支（删文件 + 移除 `plugin` 条目）。
   */
  const ROLE_GUARD_PLUGIN_REL = '.opencode/plugin/vteam-role-guard.ts';
/** guard 插件 `plugin` 数组条目匹配（任意写法均识别，清理时移除）。 */
const ROLE_GUARD_ENTRY_RE = /vteam-role-guard/;

/** guard 插件文件相对路径（单一路径方案，导出供 Todo 18 与 spec 共用）。 */
export const GUARD_PLUGIN_REL = ROLE_GUARD_PLUGIN_REL;

/**
 * OmO 插件在 opencode.json plugin 节里的条目。
 *
 * 用包名 + @latest（与官方安装器写入 $HOME 配置的写法一致）而非镜像内绝对路径：
 * OmO 是"安装器 + 插件"形态，包由 bun 在运行时按此说明解析，写死路径反而与安装器
 * 生成的状态脱节。
 */
const OMO_PLUGIN_ENTRY = 'oh-my-openagent@latest';
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
   * 注入全部四类资源，返回报告。
   *
   * 单写者保证：`opencode.json` 全程只有 `injectMcpAndAgents()` 内的一次
   * read-modify-write（mcp + plugin + agent 三节同写）；skills/tools 只碰各自
   * 目录。mcp/agent 合并放在 skills/tools 之后串行执行，避免 manifest 并发读写。
   */
  async injectAll(): Promise<InjectReport> {
    const policiesPromise = this.fetchAgentPoliciesSafe();
    const [skills, tools] = await Promise.all([this.injectSkills(), this.injectTools()]);
    const policies = await policiesPromise;
    const { mcpServers, agentPolicies } = await this.injectMcpAndAgents(policies);
    return { skills, tools, mcpServers, agentPolicies };
  }

  /**
   * 拉取 `GET /agent-policies`（与 `/mcp-servers` 同鉴权：`X-Worker-Token` +
   * `x-worker-id`，见 `getJson`）。失败/形状非法/角色集为空 → 返回 null（调用方
   * 走失败中性化），**永不抛错**（注入链不因策略拉取失败而中断 skills/tools/mcp）。
   */
  async fetchAgentPoliciesSafe(): Promise<AgentPoliciesResponse | null> {
    let data: AgentPoliciesResponse;
    try {
      data = await this.getJson<AgentPoliciesResponse>('/agent-policies', {});
    } catch (err) {
      this.logger?.warn?.(
        `[inject] /agent-policies 拉取失败，中性化 guard（roles.json enabled=false）：${(err as Error).message}`,
      );
      return null;
    }
    const roles = data?.guard?.roles;
    if (!Array.isArray(data?.agents) || !roles || typeof roles !== 'object') {
      this.logger?.warn?.('[inject] /agent-policies 响应形状非法，中性化 guard');
      return null;
    }
    if (data.agents.length === 0 || Object.keys(roles).length === 0) {
      this.logger?.warn?.('[inject] /agent-policies 角色集为空，中性化 guard');
      return null;
    }
    return data;
  }

  /** 注入启用技能：<workDir>/.opencode/skills/<name>/SKILL.md。返回注入的 skill 名。 */
  async injectSkills(): Promise<string[]> {
    const skills = await this.fetchAll<SkillRecord>('/skills', { enabled: 'true' });
    const names: string[] = [];
    for (const skill of skills) {
      try {
        const content = await this.fetchSkillContent(skill.id);
        if (content === null) {
          this.logger?.warn?.(`[inject] 技能 ${skill.id} content 拉取失败，跳过`);
          continue;
        }
        const skillDir = path.join(this.workDir, '.opencode', 'skills', skill.name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
        names.push(skill.name);
      } catch (err) {
        this.logger?.warn?.(
          `[inject] 技能 ${skill.id}（${skill.name}）注入失败: ${(err as Error).message}`,
        );
      }
    }
    this.cleanupByManifest('skills', names);
    return names;
  }

  /** 注入启用工具：<workDir>/.opencode/tools/<action>.ts。返回注入的 action 列表（mcp 型除外）。 */
  async injectTools(): Promise<string[]> {
    const tools = await this.fetchAll<ToolRecord>('/tools', { enabled: 'true' });
    const writtenFiles: string[] = [];
    const actions: string[] = [];
    for (const tool of tools) {
      if (tool.execution === 'mcp') {
        // MCP 工具不渲染为自定义工具文件——由 T8b 经 mcp-servers 配置节注入
        continue;
      }
      const def = this.buildToolDef(tool);
      if (!def) {
        this.logger?.warn?.(
          `[inject] 工具 ${tool.action} 缺少执行细节（execution=${tool.execution}），跳过注入`,
        );
        continue;
      }
      const fileName = `${def.fileName}.ts`;
      const filePath = path.join(this.workDir, '.opencode', 'tools', fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, renderCustomToolFile(def), 'utf8');
      writtenFiles.push(fileName);
      actions.push(tool.action);
    }
    this.cleanupByManifest('tools', writtenFiles);
    return actions;
  }

  /**
   * 注入 MCP 服务器：<workDir>/opencode.json 的 mcp 节（合并保留其他节）。
   * - 注入启用服务器（local/remote 两型，11 篇 §5.1 格式）
   * - manifest 比对清理：上次注入过、本次不在启用集的条目从 mcp 节移除；
   *   用户手动配置的条目（不在 manifest 中）保留不误删
   * - `agent` 节与 guard 制品原样保留（agent 刷新只发生在 `injectMcpAndAgents`
   *   的 injectAll 主链；本方法供注册后 MCP 重注入复用，不得中性化 guard）
   * 返回注入的服务器名。
   */
  async injectMcp(): Promise<string[]> {
    const servers = await this.fetchAll<McpServerRecord>('/mcp-servers', {
      enabled: 'true',
    });
    const configPath = path.join(this.workDir, 'opencode.json');
    const config = this.readConfig(configPath);
    const manifest = this.readManifest();
    const names = this.mergeMcpSection(config, servers, manifest.mcpServers ?? []);
    this.injectOmoPlugin(config);
    this.writeConfig(configPath, config);
    this.writeManifest({ ...manifest, mcpServers: names });
    return names;
  }

  /**
   * 单写者合并写：`opencode.json` 的 mcp + plugin + agent 三节在同一次
   * read-modify-write 内完成（禁止第二处并行写同一文件）。
   *
   * - `policies` 非空 → `agent` 节 = `buildAgentDefinitions(agents, guard)`（用户
   *   手写 agent 键保留），写 `roles.json{enabled:true}` + 确保 `sessions/` +
   *   **写 guard 插件文件（`renderRoleGuardPlugin()`）并注册 `plugin` 条目**
   *   （Todo 18；用户手写 plugin 条目保留，见 `ensureGuardPluginEntry`）；
   * - `policies` 为 null（拉取失败/角色集为空）→ **失败中性化**：移除受管 agent
   *   键、写 `roles.json{enabled:false}`、移除插件文件与 `plugin` 条目、删
   *   `sessions/`，报告 `{enabled:false, names:[]}`——绝不残留 `enabled:true`。
   */
  async injectMcpAndAgents(
    policies: AgentPoliciesResponse | null,
  ): Promise<{ mcpServers: string[]; agentPolicies: { enabled: boolean; names: string[] } }> {
    const servers = await this.fetchAll<McpServerRecord>('/mcp-servers', {
      enabled: 'true',
    });
    const configPath = path.join(this.workDir, 'opencode.json');
    const config = this.readConfig(configPath);
    const manifest = this.readManifest();
    const names = this.mergeMcpSection(config, servers, manifest.mcpServers ?? []);

    let agentPolicies: { enabled: boolean; names: string[] };
    if (policies !== null) {
      let agentNames: string[];
      try {
        const section = buildAgentDefinitions(policies.agents, policies.guard);
        agentNames = Object.keys(section);
        config.agent = { ...this.readAgentSection(config), ...section };
      } catch (err) {
        this.logger?.warn?.(
          `[inject] agent 定义构造失败，中性化 guard：${(err as Error).message}`,
        );
        return this.writeNeutralized(config, configPath, names);
      }
      this.writeGuardRoles(true, policies.guard.roles);
      this.ensureGuardSessionsDir();
      // Todo 18：写 guard 插件体 + 注册 plugin 条目（单写者：内存 config 改完后
      // 由本方法尾部统一落盘，此处不另写 opencode.json）。
      const guardPluginRel = this.writeGuardPluginFile();
      this.ensureGuardPluginEntry(config);
      this.cleanupByManifest('agentNames', agentNames, config);
      this.cleanupByManifest('guardRolesFile', ROLE_GUARD_ROLES_REL);
      this.cleanupByManifest('guardSessionsDir', ROLE_GUARD_SESSIONS_REL);
      this.removeStaleGuardPluginFile(manifest.guardPluginFile ?? null, guardPluginRel);
      this.writeManifest({
        ...this.readManifest(),
        mcpServers: names,
        agentNames,
        guardRolesFile: ROLE_GUARD_ROLES_REL,
        guardSessionsDir: ROLE_GUARD_SESSIONS_REL,
        guardPluginFile: guardPluginRel,
      });
      agentPolicies = { enabled: true, names: agentNames };
    } else {
      return this.writeNeutralized(config, configPath, names);
    }

    this.injectOmoPlugin(config);
    this.writeConfig(configPath, config);
    return { mcpServers: names, agentPolicies };
  }

  /**
   * 失败中性化写盘（拉取失败 / 角色集为空 / 定义构造失败三入口共用）：
   * 移除受管 agent 键 + `roles.json{enabled:false}` + 删插件文件与 `plugin` 条目
   * + 删 `sessions/`，manifest 相应键清零，报告 `{enabled:false, names:[]}`。
   */
  private writeNeutralized(
    config: Record<string, unknown>,
    configPath: string,
    mcpNames: string[],
  ): { mcpServers: string[]; agentPolicies: { enabled: boolean; names: string[] } } {
    this.cleanupByManifest('agentNames', [], config);
    this.writeGuardRoles(false, {});
    this.cleanupByManifest('guardRolesFile', ROLE_GUARD_ROLES_REL);
    this.cleanupByManifest('guardSessionsDir', null);
    this.cleanupByManifest('guardPluginFile', null, config);
    this.writeManifest({
      ...this.readManifest(),
      mcpServers: mcpNames,
      agentNames: [],
      guardRolesFile: ROLE_GUARD_ROLES_REL,
      guardSessionsDir: null,
      guardPluginFile: null,
    });
    this.removeGuardPluginEntry(config);
    this.injectOmoPlugin(config);
    this.writeConfig(configPath, config);
    return { mcpServers: mcpNames, agentPolicies: { enabled: false, names: [] } };
  }

  /** mcp 节合并（注入器管理域清理 + 用户手动条目保留），返回本次启用名。 */
  private mergeMcpSection(
    config: Record<string, unknown>,
    servers: McpServerRecord[],
    previouslyInjected: string[],
  ): string[] {
    const mcp: Record<string, unknown> = {};
    const existingMcp = this.readMcpSection(config);
    for (const name of Object.keys(existingMcp)) {
      if (!previouslyInjected.includes(name)) {
        mcp[name] = existingMcp[name];
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
      mcp[server.name] = entry;
      names.push(server.name);
    }
    config.mcp = mcp;
    return names;
  }

  /**
   * 声明 OmO（oh-my-openagent）到 opencode.json 的 plugin 节。
   *
   * 插件由**官方安装器在镜像构建期**注册（见 Dockerfile：`bunx oh-my-openagent install
   * --no-tui --platform=opencode --skip-auth`），它会把条目写进 $HOME/.config/opencode/
   * opencode.json。但 opencode 运行时的 cwd 是 <workDir>（/data/vteam-worker），读的是
   * <workDir>/opencode.json——两份配置不是同一个文件，所以这里必须把插件条目同步进来，
   * 否则 serve 根本不会加载 OmO。
   *
   * 配套前提：serve 不能带 `--pure`（--pure = 不加载外部插件），见 opencode-server.ts
   * 的 isPureMode()——默认非 pure，插件才会真正加载。
   *
   * 合并策略（与 mcp 节同思路，幂等）：
   * - 已存在指向 OmO 的条目（任意写法：包名 / @latest / 路径）→ 不重复追加；
   * - 用户手写的其他 plugin 条目一律保留。
   */
  private injectOmoPlugin(config: Record<string, unknown>): void {
    const raw = Array.isArray(config.plugin) ? config.plugin.slice() : [];
    // 迁移清理：移除历史误装的 slim fork 条目（与 OmO 不是同一个插件）
    const existing = raw.filter(
      (entry) => !(typeof entry === 'string' && OMO_SLIM_ENTRY_RE.test(entry)),
    );
    const already = existing.some(
      (entry) => typeof entry === 'string' && OMO_ENTRY_RE.test(entry),
    );
    if (!already) {
      existing.push(OMO_PLUGIN_ENTRY);
    }
    config.plugin = existing;
  }

  /** 写 guard 判定数据源 `<workDir>/.vteam-role-guard/roles.json`。 */
  private writeGuardRoles(enabled: boolean, roles: Record<string, unknown>): void {
    const filePath = path.join(this.workDir, ROLE_GUARD_ROLES_REL);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ enabled, roles }, null, 2)}\n`, 'utf8');
  }

  /** 确保 guard 会话映射目录 `<workDir>/.vteam-role-guard/sessions/` 存在。 */
  private ensureGuardSessionsDir(): void {
    fs.mkdirSync(path.join(this.workDir, ROLE_GUARD_SESSIONS_REL), { recursive: true });
  }

  /**
   * 写 guard 插件文件 `<workDir>/.opencode/plugin/vteam-role-guard.ts`
   *（内容见 `renderRoleGuardPlugin`，自包含：判定逻辑内联 + 仅 `node:` 导入）。
   * 返回相对路径（manifest `guardPluginFile` 值）。
   */
  private writeGuardPluginFile(): string {
    const filePath = path.join(this.workDir, ROLE_GUARD_PLUGIN_REL);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, renderRoleGuardPlugin(), 'utf8');
    return ROLE_GUARD_PLUGIN_REL;
  }

  /**
   * 注册 guard 插件条目到内存 `config.plugin`（调用方统一落盘，保持单写者）。
   * 幂等：已存在任意 `vteam-role-guard` 写法时仅将其规范为正典相对条目
   * `./.opencode/plugin/vteam-role-guard.ts`（显式路径注册，不依赖原生发现
   * 目录；用户手写条目保留，顺序稳定——重跑不改变数组字节）。
   */
  private ensureGuardPluginEntry(config: Record<string, unknown>): void {
    const entry = `./${ROLE_GUARD_PLUGIN_REL}`;
    const raw = Array.isArray(config.plugin) ? (config.plugin as unknown[]).slice() : [];
    const idx = raw.findIndex(
      (item) => typeof item === 'string' && ROLE_GUARD_ENTRY_RE.test(item),
    );
    if (idx === -1) {
      raw.push(entry);
    } else if (raw[idx] !== entry) {
      raw[idx] = entry;
    }
    config.plugin = raw;
  }

  /**
   * 删除与正典路径不一致的陈旧 guard 插件文件（常量变更等极端情形）。
   * 只删文件，不碰 `plugin` 数组（正典条目已由 `ensureGuardPluginEntry` 就位；
   * `removeGuardPluginEntry` 的宽匹配会误删正典条目，此处禁用）。
   */
  private removeStaleGuardPluginFile(previousRel: string | null, currentRel: string): void {
    if (previousRel && previousRel !== currentRel) {
      fs.rmSync(path.join(this.workDir, previousRel), { force: true });
    }
  }

  /**
   * 从 opencode.json `plugin` 数组移除 guard 插件条目（任意写法均匹配）。
   * 文件删除由 `cleanupByManifest('guardPluginFile', …)` 负责；此处只清数组条目，
   * 供中性化路径在 manifest 键为 null（无记录）时兜底清理残留条目。
   */
  private removeGuardPluginEntry(config: Record<string, unknown>): void {
    if (!Array.isArray(config.plugin)) {
      return;
    }
    const filtered = (config.plugin as unknown[]).filter(
      (entry) => !(typeof entry === 'string' && ROLE_GUARD_ENTRY_RE.test(entry)),
    );
    if (filtered.length !== (config.plugin as unknown[]).length) {
      config.plugin = filtered;
    }
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

  /** 按 local/remote 构造 opencode mcp 节（11 篇 §5.1）；配置不完整返回 null。 */
  private buildMcpEntry(server: McpServerRecord): Record<string, unknown> | null {
    if (server.type === 'local') {
      const command = server.command?.command;
      if (!Array.isArray(command) || command.length === 0) {
        return null;
      }
      const entry: Record<string, unknown> = { type: 'local', command };
      if (server.command?.cwd) entry.cwd = server.command.cwd;
      if (server.command?.environment) entry.environment = server.command.environment;
      if (typeof server.command?.timeout === 'number') entry.timeout = server.command.timeout;
      entry.enabled = server.enabled !== false;
      return entry;
    }
    if (server.type === 'remote') {
      if (!server.url) {
        return null;
      }
      const entry: Record<string, unknown> = { type: 'remote', url: server.url };
      if (server.headers) entry.headers = this.resolveHeaders(server.headers);
      if (server.oauth !== undefined && server.oauth !== null) {
        entry.oauth = server.oauth;
      }
      if (typeof server.timeout === 'number') entry.timeout = server.timeout;
      entry.enabled = server.enabled !== false;
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

  /** 读取配置的 mcp 节（非对象/数组时返回空对象）。 */
  private readMcpSection(config: Record<string, unknown>): Record<string, unknown> {
    const mcp = config.mcp;
    return mcp && typeof mcp === 'object' && !Array.isArray(mcp)
      ? (mcp as Record<string, unknown>)
      : {};
  }

  /** 读取配置的 agent 节（非对象/数组时返回空对象；用户手写键一并返回）。 */
  private readAgentSection(config: Record<string, unknown>): Record<string, unknown> {
    const agent = config.agent;
    return agent && typeof agent === 'object' && !Array.isArray(agent)
      ? (agent as Record<string, unknown>)
      : {};
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
   * - `tools` → 删文件（`.opencode/tools/<file>`）；
   * - `agentNames` → 重写内存中 `config.agent`，删除受管（上次注入）且不在本次
   *   集合的 agent 键（用户手写键保留；删空后移除 `agent` 节；调用方统一落盘，
   *   保持 `opencode.json` 单写者）；
   * - `guardRolesFile` → 删文件；
   * - `guardSessionsDir` → 删目录；
   * - `guardPluginFile` → 删插件文件 **并** 从内存 `config.plugin` 数组移除
   *   guard 条目（调用方统一落盘）。
   * 新键永不进入 `tools` 文件删除分支。
   */
  private cleanupByManifest(kind: 'skills' | 'tools', current: string[]): void;
  private cleanupByManifest(
    kind: 'agentNames',
    current: string[],
    config: Record<string, unknown>,
  ): void;
  private cleanupByManifest(
    kind: 'guardRolesFile' | 'guardSessionsDir' | 'guardPluginFile',
    current: string | null,
    config?: Record<string, unknown>,
  ): void;
  private cleanupByManifest(
    kind: keyof InjectManifest,
    current: string[] | string | null,
    config?: Record<string, unknown>,
  ): void {
    const manifest = this.readManifest();
    if (kind === 'skills' || kind === 'tools') {
      const names = current as string[];
      const previous: string[] = kind === 'skills' ? (manifest.skills ?? []) : (manifest.tools ?? []);
      const removed = previous.filter((p) => !names.includes(p));
      if (removed.length > 0) {
        if (kind === 'skills') {
          for (const name of removed) {
            fs.rmSync(path.join(this.workDir, '.opencode', 'skills', name), {
              recursive: true,
              force: true,
            });
          }
        } else {
          for (const file of removed) {
            fs.rmSync(path.join(this.workDir, '.opencode', 'tools', file), { force: true });
          }
        }
      }
      this.writeManifest({ ...manifest, [kind]: names });
      return;
    }
    if (kind === 'agentNames') {
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
          delete config.agent;
        } else {
          config.agent = agents;
        }
      }
      this.writeManifest({ ...manifest, agentNames: names });
      return;
    }
    const rel = current as string | null;
    if (kind !== 'guardRolesFile' && kind !== 'guardSessionsDir' && kind !== 'guardPluginFile') {
      throw new Error(
        `[inject] cleanupByManifest 不支持的键: ${String(kind)}（新键必须走显式分支，禁止进入 tools 删除分支）`,
      );
    }
    const previousRel = manifest[kind] ?? null;
    if (previousRel && previousRel !== rel) {
      const abs = path.join(this.workDir, previousRel);
      if (kind === 'guardSessionsDir') {
        fs.rmSync(abs, { recursive: true, force: true });
      } else {
        fs.rmSync(abs, { force: true });
      }
      if (kind === 'guardPluginFile' && config) {
        this.removeGuardPluginEntry(config);
      }
    }
    this.writeManifest({ ...manifest, [kind]: rel });
  }
}

// ------------------------------------------------------------------
// 模块级工具函数（导出供 spec 断言）
// ------------------------------------------------------------------

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
