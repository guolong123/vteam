/**
 * 待答复问题（v2 form）/ 权限请求的**共享检测能力**。
 *
 * ── 为什么抽成共享模块（而不是各写一份）────────────────────────────────────
 * 这份能力原本只有一处消费者：`exec-server.ts` 的 `PendingQuestionDetector`
 * （挂在 `awaitCompletion` 的 onPoll 上，检测到就上送 SESSION_QUESTION /
 * SESSION_PERMISSION 事件）。现在**配置热重载的安全闸门**也要用同一份判定：
 * `POST /api/location/reload` 会**取消**所有待答复的表单与权限请求
 * （实测：opencode v2.0.28，见 `.omo/plans/opencode-v2-progress.md` 与本任务报告），
 * ⇒ 「能不能重载」这个问题**必须**由同一个事实源回答，否则会出现两套语义：
 * 一处认为没有 pending（放行重载），另一处认为有 pending（用户正在答）——
 * 那就是**静默销毁用户正在作答的问题**（最不可接受的一类 bug）。
 *
 * ⇒ 本模块是那**唯一**的事实源：`fetchPendingForms` / `fetchPendingPermissions`
 * 是唯一「怎么向被驱动端问」的实现，`PendingQuestionDetector` 与热重载闸门
 * 都调它（不是两套 detector）。
 *
 * ── 为什么必须**按会话**查（而不是全局端点）─────────────────────────────────
 * opencode v2 有全局端点 `GET /api/form` / `GET /api/permission/request`，
 * 但它们是**按 location 作用域**的（实测 v2.0.28）：
 * `GET /api/form` 不带 location 时只返回 **serve 默认 location（= cwd = workDir）**
 * 的待答复表单；**会话被 move 到任务目录后**（vteam 的常规路径：会话建在 workDir，
 * 首次下发前 move 到任务目录），它的表单在默认 location 下**查不到**。
 * 而 `POST /api/location/reload` 取消的是**所有 location** 的 pending 项
 * （实测：两个 location 的表单都被清空）。
 * ⇒ 用默认 location 的全局端点当闸门 = **漏判**（真有待答复项却放行重载）=
 *   静默销毁用户正在作答的问题。
 * ⇒ 闸门必须**逐会话**查（`GET /api/session/{id}/form` 与 `/permission`，
 *   与 location 无关），这正是驱动 `listQuestions` / `listPermissions` 的实现。
 */

import {
  DriverPermissionRequest,
  DriverQuestionRequest,
} from '../driver/opencode-driver';

/** 最小驱动面（只用 listQuestions / listPermissions，避免依赖整个 OpenCodeDriver）。 */
export interface PendingRequestSource {
  /** 列出该会话待答复的问题（v2 form = vteam question）。 */
  listQuestions(sessionID: string): Promise<DriverQuestionRequest[]>;
  /** 列出该会话待答复的权限请求。 */
  listPermissions(sessionID: string): Promise<DriverPermissionRequest[]>;
}

/**
 * pending 检测快照。
 *
 * - `forms`：待答复表单（问题）数量；
 * - `permissions`：待答复权限请求数量；
 * - `sessions`：存在 pending 项的会话 id（去重，供日志定位到具体会话）；
 * - `incomplete`：**结论不完整**（至少一个会话的查询失败）⇒ 调用方**不得**假定
 *   「没有 pending」（安全方向：宁可不做确定性重载）。
 */
export interface PendingRequestSnapshot {
  forms: number;
  permissions: number;
  sessions: string[];
  incomplete: boolean;
}

/** 空快照（无 pending 且结论完整）。 */
export function emptyPendingSnapshot(): PendingRequestSnapshot {
  return { forms: 0, permissions: 0, sessions: [], incomplete: false };
}

/**
 * 取某会话的待答复表单（v2 form = vteam question）。
 *
 * 失败**抛错**（不吞）：调用方据此把结论标记为 `incomplete` ⇒ 不放行重载。
 */
export async function fetchPendingForms(
  source: PendingRequestSource,
  sessionID: string,
): Promise<DriverQuestionRequest[]> {
  return source.listQuestions(sessionID);
}

/**
 * 取某会话的待答复权限请求。失败**抛错**（同上）。
 */
export async function fetchPendingPermissions(
  source: PendingRequestSource,
  sessionID: string,
): Promise<DriverPermissionRequest[]> {
  return source.listPermissions(sessionID);
}

/**
 * 汇总一批会话的 pending 情况（**逐会话**查，location 无关）。
 *
 * 任一会话查询失败 ⇒ `incomplete = true`（结论不完整 ⇒ 调用方必须走「保守」分支）。
 * 单个会话失败**不影响**其它会话的结果（能查到的照常统计）。
 */
export async function detectPendingRequests(
  source: PendingRequestSource,
  sessionIDs: Iterable<string>,
): Promise<PendingRequestSnapshot> {
  const snapshot = emptyPendingSnapshot();
  const seen = new Set<string>();
  for (const raw of sessionIDs) {
    const sessionID = typeof raw === 'string' ? raw.trim() : '';
    if (sessionID === '' || seen.has(sessionID)) {
      continue;
    }
    seen.add(sessionID);
    let forms: DriverQuestionRequest[] = [];
    let permissions: DriverPermissionRequest[] = [];
    try {
      forms = await fetchPendingForms(source, sessionID);
    } catch {
      snapshot.incomplete = true;
    }
    try {
      permissions = await fetchPendingPermissions(source, sessionID);
    } catch {
      snapshot.incomplete = true;
    }
    const formCount = Array.isArray(forms) ? forms.length : 0;
    const permissionCount = Array.isArray(permissions) ? permissions.length : 0;
    snapshot.forms += formCount;
    snapshot.permissions += permissionCount;
    if (formCount > 0 || permissionCount > 0) {
      snapshot.sessions.push(sessionID);
    }
  }
  return snapshot;
}
