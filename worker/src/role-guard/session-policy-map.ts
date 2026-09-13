/**
 * session→policy 映射（vteam-role-behavior-enforcement Todo 19）。
 *
 * 落点 `<workDir>/.vteam-role-guard/sessions/<sessionId>.json`（`{ agent, dir }`），
 * 供 guard 插件（Todo 18）按 opencode session id 查角色名；未映射会话 guard
 * pass-through（绝不 fail-closed，见 role-guard/policy.ts 分支 2）。
 *
 * 约束（worker 独立进程铁律）：
 * - 仅 `node:fs/promises` + `node:path`，不 import server/opencode 代码；
 * - `SessionPolicy` 类型本地双写（对齐 `role-guard/policy.ts`），不跨模块 import
 *   亦可——此处为保持单一定義，从 `./policy` import 类型（同进程纯模块，无
 *   opencode 依赖，允许）。
 * - 写失败永不抛入执行链路：本模块函数本身可抛（调用方 exec-server 负责 catch +
 *   warn）；`removeSessionPolicy` 为 best-effort（ENOENT 静默，其余错误吞掉）。
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionPolicy } from './policy';

/** guard 制品相对路径（单一路径，与 resources/injector.ts 一致）。 */
export const SESSION_GUARD_DIR_REL = '.vteam-role-guard/sessions';

/** sessionId 文件名白名单：字母数字/`-`/`_`/`/`（opencode ses_ 前缀）/`.`；其余字符替换为 `_`。 */
const UNSAFE_SESSION_CHARS = /[^A-Za-z0-9._-]/g;

/**
 * sessionId 文件名消毒（防路径穿越）：
 * - 非字符串/空串 → `'unknown-session'`；
 * - 非法字符 → `_`；截断 128 字符（opencode id 短，此为安全上限）；
 * - 结果为 `.`/`..`/空 → `'unknown-session'`。
 */
export function sanitizeSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return 'unknown-session';
  }
  const cleaned = sessionId.replace(UNSAFE_SESSION_CHARS, '_').slice(0, 128);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'unknown-session';
  }
  return cleaned;
}

/** 会话映射文件绝对路径（workDir + sessions + 消毒后 `<id>.json`）。 */
export function sessionPolicyFilePath(workDir: string, sessionId: string): string {
  return path.join(workDir, SESSION_GUARD_DIR_REL, `${sanitizeSessionId(sessionId)}.json`);
}

/**
 * 原子写会话映射：同目录临时文件 + `rename`（POSIX 原子替换），先建 `sessions/`。
 * `agent` = opencode agent 名（如 `vteam-developer`），`dir` = 执行目录（可空串）。
 */
export async function writeSessionPolicy(
  workDir: string,
  sessionId: string,
  policy: SessionPolicy,
): Promise<void> {
  const dir = path.join(workDir, SESSION_GUARD_DIR_REL);
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${sanitizeSessionId(sessionId)}.json`);
  const tmp = path.join(
    dir,
    `.${sanitizeSessionId(sessionId)}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}.tmp`,
  );
  const body = `${JSON.stringify({ agent: policy.agent, dir: policy.dir })}\n`;
  try {
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, target);
  } finally {
    // rename 成功后 tmp 已不存在；失败残留则尽力清理（忽略错误，不污染调用方）。
    try {
      await fsp.unlink(tmp);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * 读会话映射（防御式）：缺失/损坏/形状非法 → `null`（调用方 pass-through，
 * 绝不阻断执行启动）。
 */
export async function readSessionPolicy(
  workDir: string,
  sessionId: string,
): Promise<SessionPolicy | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(sessionPolicyFilePath(workDir, sessionId), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record['agent'] !== 'string' || typeof record['dir'] !== 'string') {
      return null;
    }
    return { agent: record['agent'] as string, dir: record['dir'] as string };
  } catch {
    return null;
  }
}

/**
 * 删会话映射（best-effort，幂等）：ENOENT 静默；其余错误亦吞掉（清理路径永不抛）。
 */
export async function removeSessionPolicy(workDir: string, sessionId: string): Promise<void> {
  try {
    await fsp.unlink(sessionPolicyFilePath(workDir, sessionId));
  } catch {
    /* best-effort：缺失或删除失败均不抛 */
  }
}

/**
 * 会话映射默认存活时长（24h）：超过此年龄的 `sessions/*.json` 视为过期残留
 * （worker 重启/崩溃导致 untrack 未执行、或复用会话上的跳过写残留），由
 * `pruneStaleSessionPolicies` 清理，防止过期文件累积后误标后来的执行。
 */
export const SESSION_POLICY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 按 TTL 清理过期会话映射（best-effort，永不抛）：
 * - `sessions/` 缺失 → 返回 0（无残留可清）；
 * - 仅删 `*.json` 且 `mtime < now - ttlMs` 的文件（`.tmp` 残留与非 json 文件不动，
 *   由各自写入方负责；目录读取失败整体吞掉）；
 * - 返回删除的文件数（调用方记 info/debug，不阻断执行）。
 *
 * 未映射会话 guard 语义不变：删文件只会让对应会话回到 pass-through，
 * 绝不引入 fail-closed。
 */
export async function pruneStaleSessionPolicies(
  workDir: string,
  ttlMs: number = SESSION_POLICY_TTL_MS,
): Promise<number> {
  const dir = path.join(workDir, SESSION_GUARD_DIR_REL);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - ttlMs;
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const abs = path.join(dir, entry);
    try {
      const stat = await fsp.stat(abs);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) {
        continue;
      }
      await fsp.unlink(abs);
      pruned += 1;
    } catch {
      /* best-effort：单文件失败不影响其余 */
    }
  }
  return pruned;
}
