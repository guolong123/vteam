/**
 * OmO（oh-my-openagent）agent→模型配置读写。
 *
 * 为什么单独成模块：worker 里有两个使用方——启动期资源注入（ResourceInjector）
 * 与运行期配置端点（exec-server 的 GET/POST /omo-config）。文件格式与合并语义
 * 必须两边完全一致，抽成纯函数模块避免复制粘贴走样。
 *
 * ── 配置落点（实测确认，勿凭直觉改） ─────────────────────────────────────
 *
 * OmO 支持两个 scope 的配置（源码实证：`resolveUserOmoConfigPath()` =
 * `join(homedir, ".omo", "omo.jsonc")` 为 **user** scope；`detectOmoJsonPath(dir)` =
 * `<dir>/.omo/omo.jsonc` 为 **project** scope；OmO 自身的迁移也以 user 路径为目标）：
 *
 *   1. `~/.omo/omo.jsonc`                          ← 本平台唯一写入落点（user 级，全局生效）
 *   2. `<workDir>/.omo/omo.jsonc`                  ← 历史落点（project 级），仅兼容读取
 *   3. `<workDir>/.opencode/oh-my-openagent.jsonc` ← 更早落点，仅兼容读取
 *
 * **不得写工作目录**：工作目录是 agent 的作业区（可能是被 git 跟踪的仓库），把平台配置
 * 写进去会污染作业区、并随作业被提交。
 *
 * 因此本模块读写**一律落在 `~/.omo/omo.jsonc`**；若它不存在而工作目录里还有历史文件，
 * 则把历史文件**迁移**过去（移动后删除旧文件——旧 project 文件残留可能仍被 OmO 读取，
 * 形成「写了不生效」的幽灵配置）。全新环境直接按 user 路径创建。
 *
 * ── 格式差异 ────────────────────────────────────────────────────────────
 *
 * 新格式带平台分段与迁移标记：
 *   { "$schema": …, "[opencode]": { "agents": {…} }, "_migrations": […] }
 * 旧格式是扁平的：
 *   { "agents": {…} }
 * 读取时两者都认；写入时**保持该文件原有的形状**（有新格式就在 `[opencode]` 段里写，
 * 是旧格式就写顶层），不改动 `$schema` / `_migrations` / 其他平台段等其他键。
 *
 * 文件是 .jsonc（可含注释与尾逗号），故解析需先剥离注释；写入则输出纯 JSON
 * （JSONC 是 JSON 超集，OmO 能正常解析）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 用户级配置路径（**唯一写入落点**）：`~/.omo/omo.jsonc`（OmO user scope，全局生效）。
 *  `OMO_CONFIG_DIR` 可覆盖 `.omo` 所在目录（单测隔离用，也便于非标准 HOME 部署）；
 *  惰性求值不缓存，故运行期改该环境变量即时生效。 */
export function omoConfigUserPath(): string {
  const override = process.env.OMO_CONFIG_DIR?.trim();
  const dir =
    override && override.length > 0 ? override : path.join(os.homedir(), '.omo');
  return path.join(dir, 'omo.jsonc');
}
/** 用户级路径的展示形态（日志/前端提示用）。 */
export const OMO_CONFIG_USER_DISPLAY = '~/.omo/omo.jsonc';
/** 历史落点（工作目录内，仅兼容读取 + 迁移源）：`<workDir>/.omo/omo.jsonc`。 */
export const OMO_CONFIG_REL_PROJECT = path.join('.omo', 'omo.jsonc');
/** 更早的历史落点（同上）：`<workDir>/.opencode/oh-my-openagent.jsonc`。 */
export const OMO_CONFIG_REL_LEGACY = path.join('.opencode', 'oh-my-openagent.jsonc');
/** 新格式的平台分段键。 */
const PLATFORM_SECTION = '[opencode]';

/**
 * OmO 可配置的 agent 名。
 * 来源：包内 `oh-my-opencode.schema.json` 的 `agents` 属性键（14 个）。
 * 增删应与该 schema 同步——这是"用户能在配置页里选哪些 agent"的唯一清单。
 *
 * 注意：`atlas` 与 `hephaestus` 是**同一个位置的两个展示变体**（按模型切换）：
 * 上游 Hephaestus 仅支持 GPT-5.3-Codex/GPT-5.4/5.5/5.6 系模型，配非 GPT 模型时
 * 展示为 `Atlas - Plan Executor`。两者都在清单里，配哪个由 OmO 内部决定。
 */
export const OMO_AGENT_NAMES: readonly string[] = [
  'build',
  'plan',
  'sisyphus',
  'hephaestus',
  'sisyphus-junior',
  'OpenCode-Builder',
  'prometheus',
  'metis',
  'momus',
  'oracle',
  'librarian',
  'explore',
  'multimodal-looker',
  'atlas',
];

/** 剥离 JSONC 注释（行注释与块注释）与尾逗号，得到可 JSON.parse 的文本。 */
function stripJsonc(raw: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    const next = raw[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }
  // 尾逗号（, 后紧跟 } 或 ]）
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** 读取 JSONC（不存在/非法/非对象 → {}），不抛错。 */
function readJsoncSafe(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stripJsonc(fs.readFileSync(filePath, 'utf8'))) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 文件是否存在且为普通文件。 */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析实际生效的配置文件路径（**永远指向用户级 `~/.omo/omo.jsonc`**）。
 *
 * 规则：用户级文件存在 → 用它；否则若工作目录里还有历史文件（`.omo/omo.jsonc` 或
 * `.opencode/oh-my-openagent.jsonc`）→ **迁移**到用户级后用它（移动 + 删旧，见
 * migrateToUserPath）；都没有 → 返回用户级路径（供创建）。
 *
 * `kind` 语义沿用旧枚举以免破坏调用方：`new`=用户级已存在；`legacy`=由历史落点迁移而来；
 * `none`=全新（待创建）。`relPath` 恒为用户级展示形态 `~/.omo/omo.jsonc`。
 */
export function resolveOmoConfigPath(workDir: string): {
  /** 用于读写的绝对路径。 */
  absPath: string;
  /** 展示用路径（日志/前端提示）。 */
  relPath: string;
  /** 命中的位置类型，便于前端提示"当前生效文件"。 */
  kind: 'new' | 'legacy' | 'none';
} {
  if (isFile(omoConfigUserPath())) {
    return {
      absPath: omoConfigUserPath(),
      relPath: OMO_CONFIG_USER_DISPLAY,
      kind: 'new',
    };
  }
  for (const rel of [OMO_CONFIG_REL_PROJECT, OMO_CONFIG_REL_LEGACY]) {
    const abs = path.join(workDir, rel);
    if (isFile(abs)) {
      return {
        absPath: migrateToUserPath(abs),
        relPath: OMO_CONFIG_USER_DISPLAY,
        kind: 'legacy',
      };
    }
  }
  return {
    absPath: omoConfigUserPath(),
    relPath: OMO_CONFIG_USER_DISPLAY,
    kind: 'none',
  };
}

/**
 * 一次性迁移：把历史落点（工作目录内）的配置搬到 `~/.omo/omo.jsonc` 并**删除旧文件**。
 * 必须删旧——旧 project 文件残留可能仍被 OmO 读取，形成「写了不生效」的幽灵配置。
 * 跨文件系统 rename 会 EXDEV，故回落 copy+unlink；迁移失败（权限/IO）→ 返回旧路径
 * 继续可用（不阻断本次调用，下次再试）。
 */
function migrateToUserPath(fromAbs: string): string {
  try {
    fs.mkdirSync(path.dirname(omoConfigUserPath()), { recursive: true });
    try {
      fs.renameSync(fromAbs, omoConfigUserPath());
    } catch {
      fs.copyFileSync(fromAbs, omoConfigUserPath());
      fs.unlinkSync(fromAbs);
    }
    return omoConfigUserPath();
  } catch {
    return fromAbs;
  }
}

/** 从配置对象里取出该文件形态下的 agents 容器所在的对象。 */
function agentsContainer(
  config: Record<string, unknown>,
): { holder: Record<string, unknown>; key: string } {
  // 新格式：agents 在 "[opencode]" 段内
  const section = config[PLATFORM_SECTION];
  if (section && typeof section === 'object' && !Array.isArray(section)) {
    return { holder: section as Record<string, unknown>, key: 'agents' };
  }
  // 旧格式 / 新格式但尚未分平台：agents 在顶层
  return { holder: config, key: 'agents' };
}

/**
 * 读取 agent→模型映射（扁平 `name → "provider/model"`）。
 * 只回传 model 为字符串的条目；其他形状忽略，不抛错。
 */
export function readOmoAgents(workDir: string): Record<string, string> {
  const { absPath } = resolveOmoConfigPath(workDir);
  const config = readJsoncSafe(absPath);
  const { holder, key } = agentsContainer(config);
  const agents = holder[key];
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(agents as Record<string, unknown>)) {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as { model?: unknown }).model === 'string'
    ) {
      out[name] = (value as { model: string }).model;
    }
  }
  return out;
}

/**
 * 写入 agent→模型映射（增量合并），落在**实际生效**的那份文件上。
 *
 * 语义：
 * - 只覆盖传入的 agent；未传入的保持原样（页面可只提交改动项）；
 * - 传入空串 = 删除该 agent 的覆盖（回落 OmO 默认），而非写空 model；
 * - 该 agent 原有的其他键（variant 等）保留，只改 model；
 * - 其他顶层键（$schema / _migrations / 其他平台段）保留；
 * - 保持文件原有形状：新格式写进 `[opencode].agents`，旧格式写顶层 `agents`。
 *
 * @returns 写入的文件绝对路径
 */
export function writeOmoAgents(
  workDir: string,
  agents: Record<string, string>,
): string {
  const { absPath } = resolveOmoConfigPath(workDir);
  const config = readJsoncSafe(absPath);
  const { holder, key } = agentsContainer(config);
  const prevAgents =
    holder[key] && typeof holder[key] === 'object' && !Array.isArray(holder[key])
      ? (holder[key] as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...prevAgents };
  for (const [name, model] of Object.entries(agents)) {
    if (!model) {
      delete merged[name];
      continue;
    }
    const prev =
      merged[name] && typeof merged[name] === 'object'
        ? (merged[name] as Record<string, unknown>)
        : {};
    merged[name] = { ...prev, model };
  }
  holder[key] = merged;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return absPath;
}

/**
 * 内置种子默认模型（新数据卷首次启动、无任何 omo 配置文件时写入一次）。
 * 注意 hephaestus 上游仅支持 GPT-5.x 系，配此模型时 OmO 侧展示为 Atlas 变体，
 * 属上游行为（见 OMO_AGENT_NAMES 注释），种子仍统一写，OmO 内部决定生效形态。
 */
export const SEEDED_OMO_DEFAULT_MODEL = 'opencode/big-pickle';

/**
 * 内置种子默认 agent→模型（OMO 清单 14 个全量覆盖；已有任一位置文件一律不动，
 * 页面/API 的用户修改永远优先）。
 */
export const SEEDED_OMO_AGENT_MODELS: Readonly<Record<string, string>> =
  Object.fromEntries(OMO_AGENT_NAMES.map((n) => [n, SEEDED_OMO_DEFAULT_MODEL]));

/** 种子落盘：无配置文件时写入内置默认，有则跳过；返回写入的映射或 null（跳过）。 */
export function seedOmoAgentModels(
  workDir: string,
): Record<string, string> | null {
  if (resolveOmoConfigPath(workDir).kind !== 'none') {
    return null;
  }
  writeOmoAgents(workDir, { ...SEEDED_OMO_AGENT_MODELS });
  return { ...SEEDED_OMO_AGENT_MODELS };
}

/** 兼容旧导出名（早期版本用单一路径常量）。 */
export const OMO_CONFIG_REL = OMO_CONFIG_REL_LEGACY;
