/**
 * role-guard 纯判定模块（vteam-role-behavior-enforcement Todo 20）。
 *
 * 固定分支优先级（与计划 Decision highlights / Todo 20 Acceptance 一致）：
 *   1) `rolesDoc` 缺失、形状非法或 `enabled !== true` → allow（pass-through；
 *      解析失败绝不 fail-closed，调用方记 warn）。
 *   2) `session` 未映射或 `session.agent` 不在 `roles` → allow（pass-through；
 *      非角色会话，绝不 fail-closed）。
 *   3) 角色条目存在但残缺（缺失/非对象 `permission` 或 `tools`）→ deny（fail-closed）。
 *   4) 按工具名分支：
 *      - read 类（`read|grep|glob|lsp|webfetch|websearch|list|todowrite|todoread`）
 *        → allow（交层①原生 permission）。
 *      - edit 类（`edit|write|apply_patch|patch|multiedit`）→ 按角色
 *        `permission.edit` glob 表判定（`*:"deny"` + 无 allow 命中即 deny）；
 *        目标路径不可解析时 allow（交层①）。
 *      - `bash` → 仅按 `bashDeny` 硬化清单（大小写不敏感子串，含 `*`/`?`
 *        的条目按 glob），未命中即 allow（再由层① `permission.bash` 生效）。
 *      - `task`/`execute` → deny。
 *      - 内置通行集 `question|plan_exit|skill` → allow；`browser` 仅当列入
 *        角色 `tools` allowlist 才 allow。
 *      - 其余未知/自定义/MCP 工具（真实名，如 `vteam_<action>`、`git_clone`）
 *        → 角色 `tools` allowlist（`allow`/`ask` 放行），未列出即 deny。
 *        **默认拒绝只覆盖未知/自定义/MCP，不覆盖内置通行集。**
 *   5) 纠正文案：有 `correction.denyTemplate` 则做占位符替换，否则用默认格式。
 *
 * 约束（worker 独立进程铁律）：
 * - 纯函数：无 IO、无 fetch、不 import 任何 opencode 包（本地 `wildcardMatch`
 *   复刻 `*`→`.*` 跨分隔符语义）；
 * - 类型本地双写：对齐控制面 `/agent-policies` 下发的 guard roles 形状
 *  （`{ permission, tools, bashDeny, correction }`），绝不 import server 代码；
 * - 无角色名 `if` 分支：不 hardcode 任何 `vteam-<role>` 语义，策略全来自 `rolesDoc`。
 */

/** guard 判定数据源（`<workDir>/.vteam-role-guard/roles.json` 解析后形状）。 */
export interface RolesDoc {
  enabled: boolean;
  roles: Record<string, RolePolicy>;
}

/** 单个角色的 guard 策略（key = opencode agent 名）。 */
export interface RolePolicy {
  permission: Record<string, unknown>;
  tools: Record<string, 'allow' | 'ask'>;
  bashDeny: string[];
  correction: {
    scopeSummary?: string;
    handoff?: Record<string, string>;
    denyTemplate?: string;
  };
}

/** session→policy 映射（`<workDir>/.vteam-role-guard/sessions/<sessionId>.json` 形状）。 */
export interface SessionPolicy {
  agent: string;
  dir: string;
}

/** guard 判定结果：allow 直接放行；deny 携带纠正文案（插件侧 throw）。 */
export type GuardDecision = { action: 'allow' } | { action: 'deny'; message: string };

/** `evaluateToolCall` 入参（扁平单对象，调用方按 hook 上下文组装）。 */
export interface EvaluateToolCallParams {
  rolesDoc: RolesDoc | null;
  session: SessionPolicy | null;
  tool: string;
  args: unknown;
}

/** read 类：交层①，guard 直接放行。 */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'grep',
  'glob',
  'lsp',
  'webfetch',
  'websearch',
  'list',
  'todowrite',
  'todoread',
]);

/** edit 类：按角色 `permission.edit` glob 表判定（`edit` 是 edit/write/apply_patch 的唯一原生闸门）。 */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'apply_patch',
  'patch',
  'multiedit',
]);

/** 子代理/外部执行：永不列入 allowlist，一律 deny。 */
const TASK_TOOLS: ReadonlySet<string> = new Set(['task', 'execute']);

/**
 * 内置通行集（不属上述类别的内置工具）：交层①，guard 不做 allowlist 拦截。
 * 注意：`browser` 不在此列——它按角色 `tools` allowlist 判定。
 */
const BUILTIN_PASSTHROUGH: ReadonlySet<string> = new Set(['question', 'plan_exit', 'skill']);

/**
 * 按固定分支优先级判定一次工具调用。
 *
 * @returns `{action:'allow'}` 放行；`{action:'deny', message}` 拦截 + 纠正文案。
 */
export function evaluateToolCall(params: EvaluateToolCallParams): GuardDecision {
  const { rolesDoc, session, tool, args } = params;
  // 1) rolesDoc 缺失 / 形状非法 / enabled !== true → pass-through（绝不 fail-closed）。
  if (!isPlainObject(rolesDoc) || (rolesDoc as RolesDoc).enabled !== true) {
    return { action: 'allow' };
  }
  const roles = (rolesDoc as RolesDoc).roles;
  if (!isPlainObject(roles)) {
    return { action: 'allow' };
  }
  // 2) session 未映射 / agent 未知 → pass-through（非角色会话，绝不 fail-closed）。
  const agent = isPlainObject(session) ? (session as SessionPolicy).agent : undefined;
  if (typeof agent !== 'string' || agent.length === 0 || !hasOwn(roles, agent)) {
    return { action: 'allow' };
  }
  // 3) 角色条目残缺 → fail-closed（用角色自带模板，无模板用默认文案）。
  const role: unknown = (roles as Record<string, unknown>)[agent];
  if (!isPlainObject(role) || !isPlainObject(role.permission) || !isPlainObject(role.tools)) {
    return denyWithCorrection(agent, tool, readCorrection(role));
  }
  const policy = role as unknown as RolePolicy;

  if (typeof tool !== 'string' || tool.length === 0) {
    return { action: 'allow' };
  }
  // 4) 按工具名分支。
  if (READ_TOOLS.has(tool)) {
    return { action: 'allow' };
  }
  if (EDIT_TOOLS.has(tool)) {
    const targets = extractEditTargets(tool, args);
    if (targets.length === 0) {
      // 目标路径不可解析（apply_patch patchText 无法解析等）→ allow，交层①。
      return { action: 'allow' };
    }
    const editMap = isPlainObject(policy.permission.edit)
      ? (policy.permission.edit as Record<string, unknown>)
      : null;
    if (!editMap) {
      // 无 edit glob 表 → 无法判定越界，交层①原生 permission。
      return { action: 'allow' };
    }
    const denied = targets.some((target) => isEditDenied(target, editMap));
    return denied ? denyWithCorrection(agent, tool, policy.correction) : { action: 'allow' };
  }
  if (tool === 'bash') {
    const command = isPlainObject(args)
      ? (args as Record<string, unknown>).command
      : undefined;
    if (typeof command !== 'string' || command.length === 0) {
      return { action: 'allow' };
    }
    const patterns = Array.isArray(policy.bashDeny)
      ? policy.bashDeny.filter((p): p is string => typeof p === 'string')
      : [];
    return matchesBashDeny(command, patterns)
      ? denyWithCorrection(agent, tool, policy.correction)
      : { action: 'allow' };
  }
  if (TASK_TOOLS.has(tool)) {
    return denyWithCorrection(agent, tool, policy.correction);
  }
  if (BUILTIN_PASSTHROUGH.has(tool)) {
    return { action: 'allow' };
  }
  if (tool === 'browser') {
    return isToolAllowed(policy.tools, tool)
      ? { action: 'allow' }
      : denyWithCorrection(agent, tool, policy.correction);
  }
  // 其余未知/自定义/MCP 工具（真实名）：allowlist 默认拒绝。
  return isToolAllowed(policy.tools, tool)
    ? { action: 'allow' }
    : denyWithCorrection(agent, tool, policy.correction);
}

/**
 * 通配符匹配（本地复刻 opencode `Wildcard.match` 核心语义，不 import opencode 包）：
 * 转义正则特殊字符后 `*`→`.*`（跨路径分隔符）、`?`→`.`（单个字符），全串锚定。
 */
export function wildcardMatch(input: string, pattern: string): boolean {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') {
      source += '.*';
    } else if (ch === '?') {
      source += '.';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      source += `\\${ch}`;
    } else {
      source += ch;
    }
  }
  return new RegExp(`^${source}$`).test(input);
}

/**
 * bash 硬化匹配：与服务端 `ROLE_BASH_DENY_PATTERNS` 语义对齐——纯字符串条目做
 * 大小写不敏感的子串匹配；含 `*`/`?` 的条目按 glob（大小写不敏感）匹配。
 */
export function matchesBashDeny(command: string, patterns: readonly string[]): boolean {
  const lower = command.toLowerCase();
  return patterns.some((pattern) => {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      return false;
    }
    if (pattern.includes('*') || pattern.includes('?')) {
      return wildcardMatch(lower, pattern.toLowerCase());
    }
    return lower.includes(pattern.toLowerCase());
  });
}

/**
 * 从 unified diff / opencode patch 文本解析触及的文件路径（去重，保持出现顺序）。
 * - unified diff：`+++ b/<path>` / `+++ <path>`（跳过 `/dev/null`）；
 * - `*** Begin Patch` 体：`*** Update File: <path>` / `*** Add File:` / `*** Delete File:`。
 * 无法解析（空数组）→ 调用方按"不可解析"处理（allow，交层①）。
 */
export function parsePatchFilePaths(patchText: string): string[] {
  const found: string[] = [];
  const push = (raw: string | undefined): void => {
    if (!raw) {
      return;
    }
    const cleaned = raw.trim().replace(/^["']|["']$/g, '');
    if (!cleaned || cleaned === '/dev/null' || found.includes(cleaned)) {
      return;
    }
    found.push(cleaned);
  };
  for (const line of patchText.split('\n')) {
    const trimmed = line.trim();
    let m = /^\+\+\+\s+(?:b\/)?(\S+)\s*$/.exec(trimmed);
    if (m) {
      push(m[1]);
      continue;
    }
    m = /^\*\*\*\s+(?:Update File|Add File|Delete File):\s*(\S+)\s*$/.exec(trimmed);
    if (m) {
      push(m[1]);
    }
  }
  return found;
}

/**
 * 越界纠正文案：有 `denyTemplate` 则替换占位符（`{role}`、`<tool>`/`{tool}`、
 * `<scopeSummary>`/`{scopeSummary}`、`{handoffTarget}`），否则用默认格式。
 */
export function buildDenyMessage(
  agent: string,
  tool: string,
  correction?: RolePolicy['correction'] | null,
): string {
  const scope = typeof correction?.scopeSummary === 'string' ? correction.scopeSummary : '';
  const handoffTarget = resolveHandoffTarget(correction?.handoff, tool);
  const template =
    typeof correction?.denyTemplate === 'string' && correction.denyTemplate.length > 0
      ? correction.denyTemplate
      : null;
  if (!template) {
    return `【越界拦截｜角色：${agent}】不能调用 ${tool}。`;
  }
  return template
    .split('{role}')
    .join(agent)
    .split('<tool>')
    .join(tool)
    .split('{tool}')
    .join(tool)
    .split('<scopeSummary>')
    .join(scope)
    .split('{scopeSummary}')
    .join(scope)
    .split('{handoffTarget}')
    .join(handoffTarget);
}

// ------------------------------------------------------------------
// 内部判定辅助（不导出，语义见 evaluateToolCall）
// ------------------------------------------------------------------

/** 角色 `tools` allowlist 命中（`allow`/`ask` 放行，其余值一律拒绝）。 */
function isToolAllowed(tools: Record<string, 'allow' | 'ask'>, tool: string): boolean {
  if (!isPlainObject(tools) || !hasOwn(tools, tool)) {
    return false;
  }
  const effect = (tools as Record<string, unknown>)[tool];
  return effect === 'allow' || effect === 'ask';
}

/**
 * edit 目标是否越界：
 * - 显式 deny glob 命中即 deny（镜像层①，deny 优先）；
 * - 否则仅当 `"*":"deny"` 存在且无 allow/ask glob 命中时 deny；
 * - 其余（无 `*` 默认拒绝、或有 allow 命中）allow。
 */
function isEditDenied(targetPath: string, editMap: Record<string, unknown>): boolean {
  const target = targetPath.replace(/\\/g, '/');
  for (const [glob, effect] of Object.entries(editMap)) {
    if (glob !== '*' && effect === 'deny' && wildcardMatch(target, glob)) {
      return true;
    }
  }
  if (editMap['*'] === 'deny') {
    const allowed = Object.entries(editMap).some(
      ([glob, effect]) =>
        glob !== '*' &&
        (effect === 'allow' || effect === 'ask') &&
        wildcardMatch(target, glob),
    );
    if (!allowed) {
      return true;
    }
  }
  return false;
}

/**
 * edit 类工具的目标路径抽取（返回空 = 不可解析 → 调用方 allow 交层①）：
 * - `edit`/`write`/`multiedit`：`filePath`（兼容 `path`），`multiedit` 兼顾
 *   `files`/`filePaths` 数组与 `edits[]` 内逐项路径；
 * - `apply_patch`/`patch`：`filePath` 直命中优先，否则解析 `patchText`/`patch`
 *   文本中的文件路径（`parsePatchFilePaths`）。
 */
function extractEditTargets(tool: string, args: unknown): string[] {
  if (!isPlainObject(args)) {
    return [];
  }
  const record = args as Record<string, unknown>;
  if (tool === 'apply_patch' || tool === 'patch') {
    const direct = pickString(record, ['filePath', 'path']);
    if (direct) {
      return [direct];
    }
    const text = pickString(record, ['patchText', 'patch', 'content', 'diff']);
    if (typeof text === 'string' && text.length > 0) {
      return parsePatchFilePaths(text);
    }
    return [];
  }
  const direct = pickString(record, ['filePath', 'path']);
  if (direct) {
    return [direct];
  }
  const list = record['files'] ?? record['filePaths'];
  if (Array.isArray(list)) {
    const paths = list.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (paths.length > 0) {
      return paths;
    }
  }
  if (Array.isArray(record['edits'])) {
    const paths: string[] = [];
    for (const edit of record['edits'] as unknown[]) {
      if (isPlainObject(edit)) {
        const p = pickString(edit as Record<string, unknown>, ['filePath', 'path']);
        if (p && !paths.includes(p)) {
          paths.push(p);
        }
      }
    }
    if (paths.length > 0) {
      return paths;
    }
  }
  return [];
}

/** 按序取首个非空字符串字段。 */
function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/** 转交目标：优先同名工具键，否则 handoff 首个非空值，否则空串（模板占位符落空）。 */
function resolveHandoffTarget(handoff: unknown, tool: string): string {
  if (!isPlainObject(handoff)) {
    return '';
  }
  const record = handoff as Record<string, unknown>;
  const byTool = record[tool];
  if (typeof byTool === 'string' && byTool.length > 0) {
    return byTool;
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

/** 残缺角色也可能残留 correction 片段：能读则读，供 fail-closed 文案使用。 */
function readCorrection(role: unknown): RolePolicy['correction'] | null {
  if (!isPlainObject(role)) {
    return null;
  }
  const correction = (role as Record<string, unknown>).correction;
  if (!isPlainObject(correction)) {
    return null;
  }
  return correction as RolePolicy['correction'];
}

/** 拦截 + 纠正文案（fail-closed / allowlist 默认拒绝统一出口）。 */
function denyWithCorrection(
  agent: string,
  tool: string,
  correction: RolePolicy['correction'] | null,
): GuardDecision {
  return { action: 'deny', message: buildDenyMessage(agent, tool, correction) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
