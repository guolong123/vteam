/**
 * C5b：模型凭据 auth.json 注入器（opencode 1.18.16 实测路径结论写死于此）。
 * C6：同文件兼管 opencode.json 的 `provider` 段（baseUrl provider 配置注入，
 * 实测结论见 buildProviderSection/mergeProviderSection）。
 *
 * 注入通道：worker 直接写 `$HOME/.local/share/opencode/auth.json`（600 权限）。
 * opencode 1.18.16 实测凭据**固定**读该路径（`opencode auth list` 只认
 * `~/.local/share/opencode/auth.json`），`XDG_DATA_HOME` 不参与 auth.json 查找
 * （C5a 旧结论失效）。serve 为 spawn 子进程且 env=`{...process.env}`，继承 HOME
 * 即可读到同一路径，无需设置任何额外环境变量。
 *
 * 格式（实测）：`{ providerID: { type: 'api', key } }`。
 * token 为明文写入（权限 600 是唯一防线），退出/下次写入前 cleanup 删除文件
 * （明文 key 零留存；只删 auth.json 文件，不删 $HOME/.local/share/opencode 目录
 * —— 内含 opencode.db 会话库）。
 * opencode.json 不含明文凭据（仅 baseUrl + 模型 id 列表），故 worker 退出**不**
 * 删除它——serve 重启后可直接读取，无需等回放。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** auth.json 文件权限（仅属主读写，明文 key 的唯一防线）。 */
export const AUTH_FILE_MODE = 0o600;

/** $HOME/.local/share/opencode（auth.json 所在目录，opencode 1.18.16 实测固定读取位置）。 */
const OPENCODE_DATA_REL = ['.local', 'share', 'opencode'];

/** 单条凭据（provider → 明文 API key，来自下行 model-credentials 命令）。 */
export interface ModelCredentialEntry {
  providerID: string;
  key: string;
}

/** 注入结果（供调用方后续 cleanup）。 */
export interface AuthJsonResult {
  /** auth.json 完整路径（= $HOME/.local/share/opencode/auth.json） */
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

/** C8：per-model 能力声明（对齐 protocol/worker-protocol.ts 双写类型，内部 camelCase）。 */
export interface ModelCapabilities {
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  toolCall?: boolean;
  temperature?: boolean;
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  options?: Record<string, unknown>;
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
 * C6：opencode.json 固定写入路径（$HOME/.config/opencode/ 全局配置层，600 权限）。
 * 工作目录（/data/vteam-worker）的 opencode.json 归资源注入器管（mcp/agent/plugin），
 * 两文件 key 不相交，provider 段写全局层避免互踩。
 */
export const DEFAULT_OPENCODE_CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'opencode',
  'opencode.json',
);

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
 * C8：per-model 能力翻译（内部 camelCase → opencode 配置 snake_case 形状）。
 * 只输出实际生效的键——opencode 模型对象 schema 是 additionalProperties:false，
 * 且 `limit` 声明了 required:[context,output]：
 * - 残缺 limit（只给一半）→ **整体丢弃并 warn**（写半截会触发配置解析 InvalidError，
 *   风险是 serve 起不来，宁可少配不可写脏）；
 * - 未提供的键一律不写（留空 = opencode 用默认值：reasoning/attachment/temperature=false、
 *   tool_call=true、modalities 仅 text）。
 */
export function buildModelEntry(
  entry: ProviderModelEntry | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const name = entry?.name?.trim();
  if (name) out.name = name;
  const caps = entry?.capabilities;
  if (!caps) return out;
  const context = toPositiveInt(caps.limit?.context);
  const output = toPositiveInt(caps.limit?.output);
  if (context && output) {
    out.limit = { context, output };
  } else if (context || output) {
    console.warn(
      `[model-credential-injector] limit 残缺已丢弃（opencode 要求 context+output 同时存在）: context=${String(caps.limit?.context)} output=${String(caps.limit?.output)}`,
    );
  }
  if (typeof caps.reasoning === 'boolean') out.reasoning = caps.reasoning;
  if (typeof caps.temperature === 'boolean') out.temperature = caps.temperature;
  if (typeof caps.attachment === 'boolean') out.attachment = caps.attachment;
  if (typeof caps.toolCall === 'boolean') out.tool_call = caps.toolCall;
  const modalities = buildModalities(caps.modalities);
  if (modalities) out.modalities = modalities;
  if (
    caps.options &&
    typeof caps.options === 'object' &&
    Object.keys(caps.options).length > 0
  ) {
    out.options = caps.options;
  }
  return out;
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
 * C6：组装 opencode.json 的 `provider` 段（key 为单数，opencode 配置 schema 实测）。
 * 实测结论（opencode 1.18.31）：custom provider 必须带 npm 包名 + 显式
 * `models` map——不写 models map 时 provider 静默不出现在 `opencode models`
 * （`{baseURL}/models` 不会被自动发现），故 models 必须来自 server 目录。
 * `options.baseURL` 须为 OpenAI 兼容根（SDK 追加 /models、/chat/completions）。
 * C8：每个模型项带 per-model 能力（limit/reasoning/modalities/options…）。
 * 无效条目（空 providerID / 非 http(s) baseUrl / 无有效模型）跳过并 warn
 * （防脏负载破坏 serve 配置解析导致 serve 起不来）。
 */
export function buildProviderSection(
  providerConfigs: Record<string, ModelProviderConfigEntry> | undefined,
): Record<string, unknown> {
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
        models[modelID] = buildModelEntry(entry);
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
    section[providerID] = {
      npm: OPENAI_COMPATIBLE_NPM,
      name: providerID,
      options: { baseURL: baseUrl },
      models,
    };
  }
  return section;
}

/**
 * C6：把 provider 段并入现有 opencode.json 内容（纯函数，幂等对比用）。
 * 全局配置文件含安装器/注入器维护的 mcp/agent/plugin 等 key，只允许整体替换
 * `provider` 段，其余 key 原样保留。
 * - section=undefined → 原样返回（负载缺失，不触碰文件）；
 * - section={} → 删除 provider key（清空全部）；
 * - existingRaw=null 且 section 空 → 返回 null（无文件也不创建空文件）；
 * - existingRaw 解析失败 → 重建（warn，旧内容丢弃）。
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
  if (Object.keys(section).length === 0) {
    delete base['provider'];
  } else {
    base['provider'] = section;
  }
  return JSON.stringify(base, null, 2);
}

/**
 * C6：写 opencode.json（600，仿 writeAuthJson 双保险 chmod）。
 * 幂等：内容与现有相同 → 跳过写盘（mtime 不变，配合 F3 防循环）。
 */
export function writeOpencodeConfig(
  existingRaw: string | null,
  section: Record<string, unknown> | undefined,
): { changed: boolean; path: string } {
  const configPath = DEFAULT_OPENCODE_CONFIG_PATH;
  const newContent = mergeProviderSection(existingRaw, section);
  if (newContent === null || newContent === existingRaw) {
    return { changed: false, path: configPath };
  }
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, newContent, { mode: AUTH_FILE_MODE });
  fs.chmodSync(configPath, AUTH_FILE_MODE);
  return { changed: true, path: configPath };
}

/**
 * 写 auth.json 到 `$HOME/.local/share/opencode/auth.json`（opencode 1.18.16 实测
 * 固定读取路径）：写前 mkdir -p（含 log 子目录，serve 启动写
 * `$HOME/.local/share/opencode/log/opencode.log`，缺失会 FileSystem.open 崩溃 →
 * serve 退出 → worker 重启换端口循环）+ writeFileSync（mode 600）+ chmodSync 兜底
 * （仿临时 key 写入双保险）。返回 { authJsonPath }。
 */
export function writeAuthJson(providerKeys: ModelCredentialEntry[]): AuthJsonResult {
  const opencodeDataDir = path.join(os.homedir(), ...OPENCODE_DATA_REL);
  const authJsonPath = path.join(opencodeDataDir, 'auth.json');
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
 * 只删文件本身，**不删** $HOME/.local/share/opencode 目录（内含 opencode.db
 * 会话库，误删会导致 serve 会话状态丢失）。
 * serve 已读取 auth.json 后调用（凭据进内存后落盘明文不留存）。
 */
export function cleanupAuthJson(authJsonPath: string): void {
  if (!authJsonPath) {
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
