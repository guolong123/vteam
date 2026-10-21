/**
 * C5b：模型凭据 auth.json 注入器（opencode 1.18.16 实测路径结论写死于此）。
 * C6：同文件兼管 opencode.json 的 `providers` 段（baseUrl provider 配置注入，
 * 实测结论见 buildProviderSection/mergeProviderSection）。
 *
 * ── T16b：落点从「宿主机 $HOME」迁到「隔离配置域」────────────────────────────
 * v2 **没有 `--pure` 等价物**（T6 实测）→ 唯一可靠手段 = 给 serve 一个隔离的
 * `HOME` / `XDG_CONFIG_HOME`（见 `runtime/opencode-server.ts` 的 buildIsolatedServeEnv）。
 * ⇒ 本注入器的两个落点必须与 serve 的作用域**严格一致**，否则就是
 * 「凭据已注入但模型 401 / 无模型」这类**静默失败**（最难排查的一类）：
 * - provider 配置 → 隔离域的 `config/opencode/opencode.json`（= `XDG_CONFIG_HOME`）；
 * - 模型凭据   → 隔离域的 `data/opencode/auth.json`（= `XDG_DATA_HOME`）。
 *
 * ⚠️ **v2.0.28 实测：provider 的 API key 不从 `auth.json` 取**（auth.json 是 v1 形态）：
 * v2 的凭据真值在 SQLite 的 `credential` 表（`POST /api/credential` 写入），
 * 其"一次性导入 legacy auth.json"的迁移在 2.0.28 上**实测是 no-op**
 * （凭据表始终为空，模型请求不带 `Authorization` 头）。而 provider 配置里的
 * `settings.apiKey` **实测可用**（模型请求带 `Authorization: Bearer <key>`）。
 * ⇒ 凭据**双写**：`auth.json` 照写（v2 的 legacy 路径 + 形态兼容），
 * **同时**把 key 写进 provider 段的 `settings.apiKey`（v2 真正会读的那一处）。
 *
 * 格式（实测）：`{ providerID: { type: 'api', key } }`。
 * token 为明文写入（权限 600 是唯一防线），退出/下次写入前 cleanup 删除文件
 * （明文 key 零留存；**只删 auth.json 文件**，不删隔离域的 data 目录
 * —— 内含 opencode.db：opencode v2 的会话库是 SQLite（<data>/opencode/opencode.db），
 * 误删 = 丢会话历史）。
 *
 * ⚠️ **T7：provider 段已改写为 opencode v2 形态**（实测 opencode v2.0.28 + 官方
 * config.json schema）。v2 接受 v1 形配置但会**静默归一化**：不支持的 legacy 键被丢弃，
 * 只留一行 `level=WARN message="configuration normalization diagnostic" path=$.…`。
 * 对 vteam 而言这是最危险的降级（模型能力声明悄悄消失 → "模型可用但工具调用失败"），
 * 故：① 段本身直接写成 v2 形态（不依赖归一化）；② 写盘后回读断言（见 assertProviderConfigValid）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { OpencodeIsolationScope, resolveIsolationScope } from '../config';

/** auth.json 文件权限（仅属主读写，明文 key 的唯一防线）。 */
export const AUTH_FILE_MODE = 0o600;

/** auth.json 文件名（D11：同目录的 opencode.db 是 v2 的 SQLite 会话库，绝不可删）。 */
const AUTH_JSON_BASENAME = 'auth.json';

/** 单条凭据（provider → 明文 API key，来自下行 model-credentials 命令）。 */
export interface ModelCredentialEntry {
  providerID: string;
  key: string;
}

/** 注入结果（供调用方后续 cleanup）。 */
export interface AuthJsonResult {
  /** auth.json 完整路径（= 隔离配置域的 `<data>/opencode/auth.json`） */
  authJsonPath: string;
}

/**
 * 组装 auth.json 内容（实测格式 `{providerID: {type:'api', key}}`）。
 * 空/空白 providerID 或空 key 的条目静默跳过（防御脏负载，不产生非法 JSON）。
 */
export function buildAuthJson(providerKeys: ModelCredentialEntry[]): string {
  const map: Record<string, { type: 'api'; key: string }> = {};
  for (const entry of providerKeys ?? []) {
    const providerID = entry?.providerID?.trim();
    if (providerID && entry.key) {
      map[providerID] = { type: 'api', key: entry.key };
    }
  }
  return JSON.stringify(map, null, 2);
}

/**
 * C8：per-model 能力声明（vteam 内部 camelCase；翻译目标 = opencode **v2** 配置形状）。
 *
 * ⚠️ T7：v2 的模型对象里 `reasoning` / `tool_call` / `attachment` / `modalities` 四个
 * legacy 键**会被静默丢弃**（实测 v2.0.28：`reasoning` / `temperature` / `attachment`
 * 触发 `level=WARN message="configuration normalization diagnostic" path=$.…`），
 * v2 原生载体是 `capabilities: { tools, input[], output[] }`。
 */
export interface ModelCapabilities {
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  toolCall?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  options?: Record<string, unknown>;
}

/**
 * T7：v2 的模型能力声明形状（写入 opencode.json 的 `capabilities`）。
 * `tools` = 是否支持工具调用；`input` / `output` = 支持的输入/输出模态。
 */
export interface ModelCapabilitiesV2 {
  tools: boolean;
  input: string[];
  output: string[];
}

/** provider 配置条目内的单模型项。 */
export interface ProviderModelEntry {
  name?: string;
  capabilities?: ModelCapabilities;
}

/** C6/C8：baseUrl provider 配置条目（对齐 protocol/worker-protocol.ts 双写类型）。 */
export interface ModelProviderConfigEntry {
  baseUrl: string;
  /** 双形状兼容：旧 server 下发 string[]，C8 起为 Record<modelID, ProviderModelEntry> */
  models: string[] | Record<string, ProviderModelEntry>;
}

/**
 * C6：custom provider 唯一 npm SDK（opencode 1.18.31 实测：openai-compatible
 * 随 opencode 内置解析，无需 worker 容器预装 node_modules）。
 */
export const OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible';

/**
 * T7：v2 的 provider 加载器包名。v2 把 v1 的 `npm` 键换成 `package`，且值需带
 * `aisdk:` 前缀（实测 opencode v2.0.28：v1 形 `npm:"@ai-sdk/openai-compatible"`
 * 被归一化成 `package:"aisdk:@ai-sdk/openai-compatible"`）。
 */
export const OPENAI_COMPATIBLE_PACKAGE = `aisdk:${OPENAI_COMPATIBLE_NPM}`;

/**
 * T7：v2 的 provider 段名。v1 段名 `provider` 在 v2 已被标为 deprecated，
 * v2 原生段名是 `providers`（实测 `GET /api/config` 回显段名 `providers`）。
 */
export const OPENCODE_PROVIDER_SECTION_KEY = 'providers';

/** T7：v1 段名（`provider`）——写 v2 段时必须清掉，否则与 v2 段并存。 */
export const OPENCODE_LEGACY_PROVIDER_SECTION_KEY = 'provider';

/**
 * C6/T7：opencode.json 的全局配置路径（T16b：隔离配置域的 `XDG_CONFIG_HOME` 下）。
 * provider 段写这里；工作目录（/data/vteam-worker）的 opencode.json 归资源注入器管
 * （mcp/agent/plugin），两份文件 key 不相交（provider 段 vs 项目段），互不覆盖。
 */
export const DEFAULT_OPENCODE_CONFIG_PATH = resolveIsolationScope().configFile;

/**
 * auth.json 的落点（T16b：隔离配置域的 `XDG_DATA_HOME` 下）。
 * ⚠️ v2.0.28 实测：`opencode debug paths` → `data = $XDG_DATA_HOME/opencode`，
 * 二进制里的 legacy 凭据路径函数也是 `XDG_DATA_HOME` 优先（缺省才回落
 * `$HOME/.local/share/opencode`）⇒ **认 XDG_DATA_HOME，不认宿主 HOME**。
 */
export const DEFAULT_AUTH_JSON_PATH = resolveIsolationScope().authJsonFile;

/** opencode modalities 合法枚举（v1.18.31 schema）。 */
const MODALITY_ENUM = ['text', 'audio', 'image', 'video', 'pdf'];

/** 正整数归一（limit 用；非法/非正/非数 → undefined，避免写脏值破坏 serve 配置解析）。 */
function toPositiveInt(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const n = Math.floor(raw);
  return n > 0 ? n : undefined;
}

/** 归一 modalities（过滤非枚举值 + 去重；空数组视为未声明，避免把 text 也关掉）。 */
function buildModalities(
  raw: ModelCapabilities['modalities'],
): { input?: string[]; output?: string[] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const pick = (list: unknown): string[] | undefined => {
    if (!Array.isArray(list)) return undefined;
    const seen: string[] = [];
    for (const v of list) {
      if (typeof v === 'string' && MODALITY_ENUM.includes(v) && !seen.includes(v)) {
        seen.push(v);
      }
    }
    return seen.length > 0 ? seen : undefined;
  };
  const input = pick(raw.input);
  const output = pick(raw.output);
  if (!input && !output) return undefined;
  return { ...(input ? { input } : {}), ...(output ? { output } : {}) };
}

/**
 * C8/T7：per-model 能力翻译（vteam 内部 camelCase → opencode **v2** 配置形状）。
 *
 * 输出的 v2 模型项：
 * `{ modelID, name?, settings?, capabilities: { tools, input[], output[] }, limit?: { context, output } }`
 *
 * 映射口径（v1 键 → v2 键）：
 * - `toolCall` → `capabilities.tools`（未声明 → true：v1 未声明时 opencode 的默认值同为 true）
 * - `modalities.input` / `modalities.output` → `capabilities.input` / `capabilities.output`
 * - `attachment` → 并入 `capabilities.input`（v2 无对应布尔键，用输入模态表达"可接收附件"）
 * - `options` → `settings`（v2 把 provider/model 的 SDK 选项改叫 settings）
 * - `limit` → `limit`（v2 仍要求 context+output 同时存在；残缺 → 整体丢弃并 warn）
 * - `reasoning` / `temperature` → **不写**（见下方说明）
 *
 * ⚠️ `reasoning` / `temperature` 为什么**不写**：v2.0.28 运行时会把
 * `capabilities.reasoning` / `capabilities.temperature` 一并从归一化结果里剥掉
 * （实测：`GET /api/config` 与 `GET /api/model` 的 capabilities 只有 tools/input/output），
 * 写成 v1 顶层键则触发 WARN 被丢弃。两种写法都落不了地——写出去只是制造
 * "看起来声明了、实际没生效"的假象，故宁缺勿滥。思考强度本身没丢：
 * `options.reasoningEffort` → `settings.reasoningEffort` 会被 v2 采纳
 * （实测 v2 据此自动生成 low/medium/high 三个 variant）。
 */
export function buildModelEntry(
  modelID: string,
  entry: ProviderModelEntry | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (modelID) {
    out.modelID = modelID;
  }
  const name = entry?.name?.trim();
  if (name) out.name = name;
  const caps = entry?.capabilities;
  if (caps) {
    const context = toPositiveInt(caps.limit?.context);
    const output = toPositiveInt(caps.limit?.output);
    if (context && output) {
      out.limit = { context, output };
    } else if (context || output) {
      console.warn(
        `[model-credential-injector] limit 残缺已丢弃（opencode 要求 context+output 同时存在）: context=${String(caps.limit?.context)} output=${String(caps.limit?.output)}`,
      );
    }
  }
  out.capabilities = buildV2Capabilities(caps);
  if (
    caps?.options &&
    typeof caps.options === 'object' &&
    !Array.isArray(caps.options) &&
    Object.keys(caps.options).length > 0
  ) {
    out.settings = { ...caps.options };
  }
  return out;
}

/**
 * T7：v1 能力键 → v2 `capabilities` 的映射。
 *
 * - `tools`：`toolCall` 显式值优先；未声明取 true（v1 未声明时 opencode 的默认值同为 true）。
 * - `input` / `output`：取 `modalities` 的显式声明（过滤枚举 + 去重）；未声明时取
 *   `['text']`（v1 未声明 modalities 时的默认口径）。`text` 恒在——所有模型都收发文本，
 *   缺失只可能是运营漏选，补上比留空更安全。
 * - `attachment: true` → 并入 `'image'`：v2 没有附件布尔键，用输入模态表达；
 *   显式声明过 modalities 时不覆盖它（声明即权威），只保证 image 不缺席。
 */
function buildV2Capabilities(
  caps: ModelCapabilities | undefined,
): ModelCapabilitiesV2 {
  const modalities = buildModalities(caps?.modalities);
  const input: string[] = [...(modalities?.input ?? [])];
  if (!input.includes('text')) {
    input.push('text');
  }
  if (caps?.attachment === true && !input.includes('image')) {
    input.push('image');
  }
  const output: string[] = [...(modalities?.output ?? [])];
  if (!output.includes('text')) {
    output.push('text');
  }
  return {
    tools: typeof caps?.toolCall === 'boolean' ? caps.toolCall : true,
    input,
    output,
  };
}

/** 归一 models 双形状（旧 server 的 string[] → 空配置项；新 server 的 Record 原样）。 */
function normalizeProviderModels(
  raw: string[] | Record<string, ProviderModelEntry> | undefined,
): Record<string, ProviderModelEntry> {
  if (Array.isArray(raw)) {
    const out: Record<string, ProviderModelEntry> = {};
    for (const item of raw) {
      const modelID = typeof item === 'string' ? item.trim() : '';
      if (modelID) out[modelID] = {};
    }
    return out;
  }
  return raw && typeof raw === 'object' ? raw : {};
}

/**
 * C6/T7：组装 opencode.json 的 `providers` 段（v2 段名；v1 段名 `provider` 已被 v2 标为
 * deprecated，归一化后回显段名为 `providers`）。
 *
 * 产出的 v2 provider 条目（实测 opencode v2.0.28 `GET /api/config` 回显 + 官方 config.json schema）：
 * `{ name, package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL, apiKey? }, models: {…} }`
 *
 * v1 → v2 的键改写：`npm` → `package`（值加 `aisdk:` 前缀）、`options` → `settings`。
 * 无效条目（空 providerID / 非 http(s) baseUrl / 无有效模型）跳过并 warn
 * （防脏负载破坏 serve 配置解析导致 serve 起不来）。
 *
 * ⚠️ **`settings.apiKey`（T16b 实测）**：v2.0.28 **不从 `auth.json` 取 provider 的
 * API key**（凭据真值在 SQLite `credential` 表；legacy auth.json 的一次性导入迁移实测
 * 是 no-op），而 provider 配置里的 `settings.apiKey` **实测可用**（模型请求带
 * `Authorization: Bearer <key>`）⇒ 传入 `providerKeys` 时把 key 写进 settings，
 * 否则 worker 会"注入成功但模型无凭据"（静默不可用）。
 * ⚠️ 代价：明文 key 因此也落在 opencode.json 里（600 权限、隔离域内）——
 * v2 自己的凭据表同样是明文落盘，暴露面没有实质增加。
 */
export function buildProviderSection(
  providerConfigs: Record<string, ModelProviderConfigEntry> | undefined,
  providerKeys?: ModelCredentialEntry[],
): Record<string, unknown> {
  const keysByProvider = new Map<string, string>();
  for (const entry of providerKeys ?? []) {
    const providerID = entry?.providerID?.trim();
    if (providerID && entry.key) {
      keysByProvider.set(providerID, entry.key);
    }
  }
  const section: Record<string, unknown> = {};
  for (const [rawId, cfg] of Object.entries(providerConfigs ?? {})) {
    const providerID = rawId?.trim();
    const baseUrl = cfg?.baseUrl?.trim();
    const models: Record<string, unknown> = {};
    for (const [rawModel, entry] of Object.entries(
      normalizeProviderModels(cfg?.models),
    )) {
      const modelID = rawModel?.trim();
      if (modelID) {
        models[modelID] = buildModelEntry(modelID, entry);
      }
    }
    if (
      !providerID ||
      !baseUrl ||
      !/^https?:\/\/.+/.test(baseUrl) ||
      Object.keys(models).length === 0
    ) {
      console.warn(
        `[model-credential-injector] opencode provider 配置无效跳过: provider=${providerID ?? '(空)'} baseUrl=${baseUrl ?? '(空)'} models=${Object.keys(models).length}`,
      );
      continue;
    }
    const apiKey = keysByProvider.get(providerID);
    section[providerID] = {
      name: providerID,
      package: OPENAI_COMPATIBLE_PACKAGE,
      settings: apiKey ? { baseURL: baseUrl, apiKey } : { baseURL: baseUrl },
      models,
    };
  }
  return section;
}

/**
 * C6/T7：把 provider 段并入现有 opencode.json 内容（纯函数，幂等对比用）。
 * 全局配置文件含安装器/注入器维护的 mcp/agent/plugin 等 key，只允许整体替换
 * provider 段，其余 key 原样保留。
 * - section=undefined → 原样返回（负载缺失，不触碰文件）；
 * - section={} → 删除 provider 段（清空全部）；
 * - existingRaw=null 且 section 空 → 返回 null（无文件也不创建空文件）；
 * - existingRaw 解析失败 → 重建（warn，旧内容丢弃）。
 *
 * ⚠️ T7：段名用 v2 的 `providers`；同时清掉 v1 段名 `provider`——两段并存时 v2 会把
 * legacy 段静默归一化（`npm`/`options`/`reasoning` 等键被丢弃且只留一行 WARN），
 * 留着它等于留一份"看着有、实际丢"的配置。
 */
export function mergeProviderSection(
  existingRaw: string | null,
  section: Record<string, unknown> | undefined,
): string | null {
  if (section === undefined) {
    return existingRaw;
  }
  if (existingRaw === null && Object.keys(section).length === 0) {
    return null;
  }
  let base: Record<string, unknown> = {};
  if (existingRaw) {
    try {
      const parsed: unknown = JSON.parse(existingRaw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      console.warn(
        '[model-credential-injector] 现有 opencode.json 解析失败，重建（旧内容丢弃）',
      );
    }
  }
  delete base[OPENCODE_LEGACY_PROVIDER_SECTION_KEY];
  if (Object.keys(section).length === 0) {
    delete base[OPENCODE_PROVIDER_SECTION_KEY];
  } else {
    base[OPENCODE_PROVIDER_SECTION_KEY] = section;
  }
  return JSON.stringify(base, null, 2);
}

/**
 * T7：provider 段的一条校验问题（= 一个缺失或非法的 v2 必备键）。
 */
export interface ProviderConfigIssue {
  /** 键路径（形如 `$.providers.keta-qwen.models.qwen.capabilities`） */
  path: string;
  /** 人类可读原因（说明缺什么、为什么 v2 会把它丢掉） */
  reason: string;
}

/**
 * T7：provider 段不符合 v2 形态时抛出的配置错误。
 *
 * 这是"宽松匹配 + 兜底断言"里的**兜底**那一半：v2 的归一化 WARN 文案未文档化、
 * 可能随版本变，光靠日志识别迟早会漏；写盘后回读断言不依赖任何文案——
 * 段里少一个 v2 必备键，就当场报错，绝不让 worker 带着"看着有、实际被丢"的
 * 模型能力数据跑起来（症状是"模型可用但工具调用失败"，极难定位）。
 */
export class ProviderConfigError extends Error {
  readonly issues: ProviderConfigIssue[];

  constructor(issues: ProviderConfigIssue[]) {
    super(
      `[model-credential-injector] opencode.json provider 段不符合 opencode v2 形态：${issues
        .map((issue) => `${issue.path}（${issue.reason}）`)
        .join('；')}`,
    );
    this.name = 'ProviderConfigError';
    this.issues = issues;
  }
}

/** 正整数判定（limit 用）。 */
function isPositiveInt(raw: unknown): boolean {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0;
}

/**
 * T7：检查一份 opencode.json 内容里的 provider 段是否**确实是 v2 形态**。
 *
 * 必检键（缺任一 → 报 issue）：
 * - `providers.<id>.package`（v1 键 `npm` 已被 v2 丢弃）
 * - `providers.<id>.settings.baseURL`（v1 键 `options.baseURL` 已被 v2 丢弃）
 * - `providers.<id>.models.<model>.capabilities.{tools,input,output}`
 *   （v1 键 `reasoning`/`tool_call`/`attachment`/`modalities` 已被 v2 丢弃）
 * - `providers.<id>.models.<model>.limit.context` / `.output`
 *   （v2 要求两者同时存在；limit 整体缺失不算问题——vteam 目录未声明完整 limit 时
 *   按既有"宁可少配不可写脏"策略丢弃该键，见 buildModelEntry）
 *
 * 另外：残留 v1 段名 `provider` 也会报 issue（两段并存 = 留了一份注定被丢的配置）。
 */
export function findProviderConfigIssues(configRaw: string): ProviderConfigIssue[] {
  const issues: ProviderConfigIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(configRaw);
  } catch {
    return [{ path: '$', reason: '配置文件不是合法 JSON' }];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [{ path: '$', reason: '配置文件根节点不是对象' }];
  }
  const root = parsed as Record<string, unknown>;
  if (root[OPENCODE_LEGACY_PROVIDER_SECTION_KEY] !== undefined) {
    issues.push({
      path: `$.${OPENCODE_LEGACY_PROVIDER_SECTION_KEY}`,
      reason: `仍存在 v1 段名（v2 段名为 ${OPENCODE_PROVIDER_SECTION_KEY}），legacy 段会被 v2 静默归一化丢弃`,
    });
  }
  const providers = root[OPENCODE_PROVIDER_SECTION_KEY];
  if (providers === undefined || providers === null) {
    issues.push({
      path: `$.${OPENCODE_PROVIDER_SECTION_KEY}`,
      reason: `缺少 v2 provider 段（${OPENCODE_PROVIDER_SECTION_KEY}）`,
    });
    return issues;
  }
  if (typeof providers !== 'object' || Array.isArray(providers)) {
    issues.push({
      path: `$.${OPENCODE_PROVIDER_SECTION_KEY}`,
      reason: '不是对象',
    });
    return issues;
  }
  for (const [providerID, rawProvider] of Object.entries(
    providers as Record<string, unknown>,
  )) {
    const providerPath = `$.${OPENCODE_PROVIDER_SECTION_KEY}.${providerID}`;
    if (
      !rawProvider ||
      typeof rawProvider !== 'object' ||
      Array.isArray(rawProvider)
    ) {
      issues.push({ path: providerPath, reason: '不是对象' });
      continue;
    }
    const provider = rawProvider as Record<string, unknown>;
    if (
      typeof provider['package'] !== 'string' ||
      provider['package'].trim() === ''
    ) {
      issues.push({
        path: `${providerPath}.package`,
        reason: '缺少 v2 provider 加载器包名（v1 键 `npm` 会被 v2 丢弃）',
      });
    }
    const settings = provider['settings'];
    if (
      !settings ||
      typeof settings !== 'object' ||
      Array.isArray(settings) ||
      typeof (settings as Record<string, unknown>)['baseURL'] !== 'string' ||
      String((settings as Record<string, unknown>)['baseURL']).trim() === ''
    ) {
      issues.push({
        path: `${providerPath}.settings.baseURL`,
        reason: '缺少 provider baseURL（v1 键 `options.baseURL` 会被 v2 丢弃）',
      });
    } else if ('apiKey' in (settings as Record<string, unknown>)) {
      // T16b：apiKey 是 v2.0.28 真正会读的那一处（auth.json 实测不被采用），
      // 写坏了 = 凭据形同虚设 → 写后断言当场报错，别让它静默生效。
      const apiKey = (settings as Record<string, unknown>)['apiKey'];
      if (typeof apiKey !== 'string' || apiKey.trim() === '') {
        issues.push({
          path: `${providerPath}.settings.apiKey`,
          reason: '存在但不是非空字符串（v2 的 provider 凭据载体，写坏即模型无凭据）',
        });
      }
    }
    const models = provider['models'];
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
      issues.push({ path: `${providerPath}.models`, reason: '缺少 models map' });
      continue;
    }
    for (const [modelID, rawModel] of Object.entries(
      models as Record<string, unknown>,
    )) {
      const modelPath = `${providerPath}.models.${modelID}`;
      if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) {
        issues.push({ path: modelPath, reason: '不是对象' });
        continue;
      }
      const model = rawModel as Record<string, unknown>;
      const capabilities = model['capabilities'];
      if (
        !capabilities ||
        typeof capabilities !== 'object' ||
        Array.isArray(capabilities)
      ) {
        issues.push({
          path: `${modelPath}.capabilities`,
          reason:
            '缺少 v2 模型能力声明（v1 键 reasoning/tool_call/attachment/modalities 会被 v2 丢弃）',
        });
      } else {
        const caps = capabilities as Record<string, unknown>;
        if (typeof caps['tools'] !== 'boolean') {
          issues.push({
            path: `${modelPath}.capabilities.tools`,
            reason: '必须是布尔值',
          });
        }
        for (const dir of ['input', 'output'] as const) {
          const list = caps[dir];
          if (
            !Array.isArray(list) ||
            list.some((item) => typeof item !== 'string')
          ) {
            issues.push({
              path: `${modelPath}.capabilities.${dir}`,
              reason: '必须是字符串数组',
            });
          }
        }
      }
      const limit = model['limit'];
      if (limit !== undefined && limit !== null) {
        if (typeof limit !== 'object' || Array.isArray(limit)) {
          issues.push({ path: `${modelPath}.limit`, reason: '不是对象' });
        } else {
          const limitObj = limit as Record<string, unknown>;
          if (!isPositiveInt(limitObj['context'])) {
            issues.push({
              path: `${modelPath}.limit.context`,
              reason: '缺失或非正整数（v2 要求 context+output 同时存在）',
            });
          }
          if (!isPositiveInt(limitObj['output'])) {
            issues.push({
              path: `${modelPath}.limit.output`,
              reason: '缺失或非正整数（v2 要求 context+output 同时存在）',
            });
          }
        }
      }
    }
  }
  return issues;
}

/**
 * T7：断言一份 opencode.json 内容的 provider 段符合 v2 形态；不符合 → 抛
 * `ProviderConfigError`（列出每个缺失/非法的键路径）。
 */
export function assertProviderConfigValid(configRaw: string): void {
  const issues = findProviderConfigIssues(configRaw);
  if (issues.length > 0) {
    throw new ProviderConfigError(issues);
  }
}

/**
 * 读隔离域 auth.json 里的 provider → key 映射（文件缺失/损坏 → 空 map）。
 *
 * 为什么需要它：v2.0.28 的 provider API key 真值载体是 provider 段的 `settings.apiKey`
 * （见 buildProviderSection），而**凭据文件本身**才是 key 的**真值来源**——所有写配置的
 * 入口都从 auth.json 回填 key，这样任何"只拿到 baseUrl+models、没拿到 key"的写入方
 * （例如本地 admin 通道 `POST /config/model-credentials`）都**不会把 key 抹掉**
 * （抹掉 = 模型静默无凭据）。
 */
export function readAuthJsonKeys(
  scope: OpencodeIsolationScope = resolveIsolationScope(),
): Map<string, string> {
  const keys = new Map<string, string>();
  const raw = readFileOrNull(scope.authJsonFile);
  if (!raw) {
    return keys;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [providerID, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const key = (value as { key?: unknown }).key;
      if (typeof key === 'string' && key !== '') {
        keys.set(providerID, key);
      }
    }
  } catch {
    // 损坏的 auth.json → 当作没有凭据（写盘路径会覆盖它）
  }
  return keys;
}

/**
 * 把 auth.json 里的 key 回填到 provider 段中**缺 key** 的 provider 上（已带 key 的不动）。
 * auth.json 里也没有该 provider 的 key → 保持原样（不写空 apiKey）。
 */
function attachApiKeysFromAuthJson(
  section: Record<string, unknown> | undefined,
  scope: OpencodeIsolationScope,
): Record<string, unknown> | undefined {
  if (!section) {
    return section;
  }
  const keys = readAuthJsonKeys(scope);
  if (keys.size === 0) {
    return section;
  }
  const out: Record<string, unknown> = {};
  for (const [providerID, provider] of Object.entries(section)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      out[providerID] = provider;
      continue;
    }
    const entry = provider as Record<string, unknown>;
    const settings = entry['settings'];
    const settingsObj =
      settings && typeof settings === 'object' && !Array.isArray(settings)
        ? (settings as Record<string, unknown>)
        : {};
    const existingKey = settingsObj['apiKey'];
    if (typeof existingKey === 'string' && existingKey !== '') {
      out[providerID] = provider;
      continue;
    }
    const key = keys.get(providerID);
    out[providerID] = key
      ? { ...entry, settings: { ...settingsObj, apiKey: key } }
      : provider;
  }
  return out;
}

/**
 * C6/T7：写 opencode.json（600，仿 writeAuthJson 双保险 chmod）。
 * 幂等：内容与现有相同 → 跳过写盘（mtime 不变，配合 F3 防循环）。
 *
 * ⚠️ T7 兜底断言：写入（或确认未变）后**回读文件**再断言 v2 形态——
 * v2 的归一化是静默的，段里少一个必备键不会报错，只会让模型能力声明悄悄消失。
 *
 * @param scope 隔离配置域（T16b）；缺省 = 默认隔离域（`<HOME>/.opencode-iso`）。
 */
export function writeOpencodeConfig(
  existingRaw: string | null,
  section: Record<string, unknown> | undefined,
  scope: OpencodeIsolationScope = resolveIsolationScope(),
): { changed: boolean; path: string } {
  const configPath = scope.configFile;
  const effectiveSection = attachApiKeysFromAuthJson(section, scope);
  const newContent = mergeProviderSection(existingRaw, effectiveSection);
  const hasProviderSection =
    effectiveSection !== undefined && Object.keys(effectiveSection).length > 0;
  if (newContent === null || newContent === existingRaw) {
    if (hasProviderSection) {
      assertProviderConfigValid(readFileOrNull(configPath) ?? newContent ?? '');
    }
    return { changed: false, path: configPath };
  }
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, newContent, { mode: AUTH_FILE_MODE });
  fs.chmodSync(configPath, AUTH_FILE_MODE);
  if (hasProviderSection) {
    assertProviderConfigValid(readFileOrNull(configPath) ?? newContent);
  }
  return { changed: true, path: configPath };
}

/** 读文件内容（不存在/不可读 → null，静默降级）。 */
function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 写 auth.json 到隔离配置域的 `data/opencode/auth.json`（T16b）。
 * 写前 mkdir -p（含 log 子目录，serve 启动写 `<data>/opencode/log/opencode.log`，
 * 缺失会 FileSystem.open 崩溃 → serve 退出 → worker 重启换端口循环）
 * + writeFileSync（mode 600）+ chmodSync 兜底（仿临时 key 写入双保险）。
 *
 * ⚠️ **v2.0.28 实测**：这个文件**不再**是 provider API key 的来源（v2 的凭据真值在
 * SQLite `credential` 表；legacy 导入迁移实测是 no-op）——它保留是为了 v1 形态兼容与
 * 排查线索，**真正生效的载体是 provider 段的 `settings.apiKey`**（见 buildProviderSection）。
 *
 * @param scope 隔离配置域（T16b）；缺省 = 默认隔离域（`<HOME>/.opencode-iso`）。
 */
export function writeAuthJson(
  providerKeys: ModelCredentialEntry[],
  scope: OpencodeIsolationScope = resolveIsolationScope(),
): AuthJsonResult {
  const opencodeDataDir = path.dirname(scope.authJsonFile);
  const authJsonPath = scope.authJsonFile;
  fs.mkdirSync(opencodeDataDir, { recursive: true });
  fs.mkdirSync(path.join(opencodeDataDir, 'log'), { recursive: true });
  fs.writeFileSync(authJsonPath, buildAuthJson(providerKeys), {
    mode: AUTH_FILE_MODE,
  });
  fs.chmodSync(authJsonPath, AUTH_FILE_MODE);
  return { authJsonPath };
}

/**
 * 删除 auth.json 文件（幂等：不存在静默忽略；仿临时 key 清理幂等）。
 * 只删文件本身，**不删**隔离域的 data 目录（内含 opencode.db 会话库，
 * 误删会导致 serve 会话状态丢失）。
 * serve 已读取 auth.json 后调用（凭据进内存后落盘明文不留存）。
 *
 * ⚠️ D11 铁律：opencode v2 的会话状态在 **SQLite** `<data>/opencode/opencode.db`
 * ——它与 auth.json **同目录**。本函数只允许删 `auth.json` 这一个文件：
 * 传入路径的文件名不是 `auth.json` 时直接跳过（防调用方误传 db 路径把会话库删掉）。
 */
export function cleanupAuthJson(authJsonPath: string): void {
  if (!authJsonPath) {
    return;
  }
  if (path.basename(authJsonPath) !== AUTH_JSON_BASENAME) {
    console.warn(
      `[model-credential-injector] 拒绝清理非 auth.json 文件（opencode.db 是 v2 会话库，误删即丢历史）: ${authJsonPath}`,
    );
    return;
  }
  try {
    fs.rmSync(authJsonPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
