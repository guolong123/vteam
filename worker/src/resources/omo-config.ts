/**
 * OmO（oh-my-openagent）agent→模型配置读写。
 *
 * 为什么单独成模块：worker 里有两个使用方——启动期资源注入（ResourceInjector）
 * 与运行期配置端点（exec-server 的 GET/POST /omo-config）。文件格式与合并语义
 * 必须两边完全一致，抽成纯函数模块避免复制粘贴走样。
 *
 * ── 配置落点（实测确认，勿凭直觉改） ─────────────────────────────────────
 *
 * OmO 会按以下顺序查找配置，**先命中者胜**：
 *
 *   1. `<workDir>/.omo/omo.jsonc`                    ← 当前生效（迁移后的新位置）
 *   2. `<workDir>/.opencode/oh-my-openagent.jsonc`   ← 旧位置，仅当上面不存在时接管
 *
 * 两者都能被 OmO 读取；同时存在时 `.omo/omo.jsonc` 胜出，旧文件变成"死配置"。
 * 实证方法（两份设成不同值、重启、看实际使用的模型）：
 *   - 只改 .omo/omo.jsonc        → 生效（另一份不动）
 *   - 只改 .opencode/…jsonc，.omo 存在 → **不生效**
 *   - 移走 .omo/omo.jsonc 后再改 .opencode/…jsonc → 生效
 *
 * 所以本模块的读写**优先落在 `.omo/omo.jsonc`**；若它不存在而旧文件存在，
 * 则写回旧文件（保持既有部署的落点不变，避免凭空多出一份）。
 * 两份都不存在时（全新环境）按新位置创建。
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
import * as path from 'path';

/** 新位置（当前生效）：`<workDir>/.omo/omo.jsonc`。 */
export const OMO_CONFIG_REL_NEW = path.join('.omo', 'omo.jsonc');
/** 旧位置（仅在无新文件时接管）：`<workDir>/.opencode/oh-my-openagent.jsonc`。 */
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
 * 解析实际生效的配置文件路径。
 *
 * 规则（对齐 OmO 的查找顺序）：`.omo/omo.jsonc` 存在则用它；否则若旧文件存在则用旧的；
 * 两者都不存在 → 返回新位置（供创建）。
 */
export function resolveOmoConfigPath(workDir: string): {
  /** 用于读写的绝对路径。 */
  absPath: string;
  /** 相对 workDir 的路径（用于展示/日志）。 */
  relPath: string;
  /** 命中的位置类型，便于前端提示"当前生效文件"。 */
  kind: 'new' | 'legacy' | 'none';
} {
  const newAbs = path.join(workDir, OMO_CONFIG_REL_NEW);
  if (isFile(newAbs)) {
    return { absPath: newAbs, relPath: OMO_CONFIG_REL_NEW, kind: 'new' };
  }
  const legacyAbs = path.join(workDir, OMO_CONFIG_REL_LEGACY);
  if (isFile(legacyAbs)) {
    return { absPath: legacyAbs, relPath: OMO_CONFIG_REL_LEGACY, kind: 'legacy' };
  }
  return { absPath: newAbs, relPath: OMO_CONFIG_REL_NEW, kind: 'none' };
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

/** 兼容旧导出名（早期版本用单一路径常量）。 */
export const OMO_CONFIG_REL = OMO_CONFIG_REL_LEGACY;
