/**
 * worker 自更新状态通道（worker-self-update Todo 3 服务端 ↔ Todo 4 worker 执行器**共享契约**）。
 *
 * worker 在 register/heartbeat 请求体上报两个可选字段（server 只做透传 + 落库，不发明状态）：
 *   - `updateState`：自更新执行状态机的当前值 → `workers.update_state`（可空）；
 *   - `rolledBack`：一次性结果标志「最近一次自更新被自动回滚」→ `workers.rolled_back`。
 *
 * ⚠️ **字段名与取值必须与 worker 侧逐字一致**（Todo 4 实现的更新执行器发出这两项，
 * web 侧 Todo 5 也按同一组取值渲染状态行）。改这里 = 改协议，必须两端同步。
 *
 * 为什么落库而不是纯内存：这两个字段回答的是「上次更新**结果如何**」，UI 在
 * server 重启后仍须展示（已下载待手动重启 / 已回滚）。纯内存态会让 server 一重启
 * 就把「已回滚」悄悄变回「未回滚」——那是最不该被吞掉的一条运维事实。
 * 待下发的 update-worker **指令**仍只在内存（命令一次有效，见 workers.service.ts），
 * 两类状态刻意分开：指令是瞬时的，事实是可追溯的。
 *
 * 旧 worker 完全不携带这两个字段：DTO 全部 @IsOptional，缺席 = 「没上报」→
 * 不写列（保留 register 阶段的旧值），UI 显示未知/未回滚，server 不报错。
 */

/** 自更新执行状态机的取值（worker 执行器上报；server 只透传与展示）。 */
export const WORKER_UPDATE_STATES = {
  /** 指令已收到，等待空闲（Todo 4：idle 判定未通过时保持此态并保留下轮重试）。 */
  PENDING: 'pending',
  /** 正在下载 tarball（sha256 校验未过即放弃重试，不覆盖旧码）。 */
  DOWNLOADING: 'downloading',
  /** 已覆盖新码，正在重启（systemd 可用路径）。 */
  RESTARTING: 'restarting',
  /** 已下载校验通过但无 systemd：等人工重启（worker 绝不自杀）。 */
  READY_MANUAL: 'ready-manual',
  /** 自动回滚已生效（新版本起不来，恢复 dist.prev 后上报）。 */
  ROLLEDBACK: 'rolledback',
} as const;

export type WorkerUpdateState =
  (typeof WORKER_UPDATE_STATES)[keyof typeof WORKER_UPDATE_STATES];

/**
 * `workers.update_state` 列宽（varchar(191)，与本仓其余字符串列同宽）。
 * 全部枚举取值长度 ≤ 11，远在列宽内——故归一化只需校验取值，不做截断
 * （超长脏值在枚举校验处已被判为「未上报」，进不了这一列）。
 */
export const WORKER_UPDATE_STATE_MAX_LENGTH = 191;

/**
 * 「版本未知」的字面量：本地开发栈 / 未注入 `WORKER_CODE_VERSION` 且 dist 里没有
 * version.js 时 worker 解析出的版本。它是占位事实，**永不参与版本比对**——
 * 否则 `dev === dev` 会被当成「版本已对齐」，凭空显示「已是最新」。
 */
export const WORKER_UNKNOWN_CODE_VERSION = 'dev';

/** 值是否属于自更新状态机枚举（未知取值不猜、不落库）。 */
export function isWorkerUpdateState(
  value: unknown,
): value is WorkerUpdateState {
  return (
    typeof value === 'string' &&
    (Object.values(WORKER_UPDATE_STATES) as string[]).includes(value.trim())
  );
}

/**
 * 归一化 worker 上报的 updateState。
 * undefined / null / 空串 / 纯空白 → undefined（调用方**不写该列**）；
 * 不在枚举内的取值 → undefined（HTTP 边界已由 `@IsIn` 拦截；这里做服务层纵深防御，
 * 免得直接调 service 的新代码路径把脏值写进 UI 会展示的列）；
 * 枚举内取值 → trim 后原样返回（全部取值长度 ≤ 11，天然落在 varchar(64) 内）。
 */
export function normalizeReportedUpdateState(
  raw: string | null | undefined,
): WorkerUpdateState | undefined {
  if (raw === null || raw === undefined) return undefined;
  const trimmed = raw.trim();
  return isWorkerUpdateState(trimmed) ? trimmed : undefined;
}

/** 版本串是否「可比对」：非空且不是 `dev` 这类未知占位。 */
export function isComparableCodeVersion(
  raw: string | null | undefined,
): boolean {
  if (raw === null || raw === undefined) return false;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed !== WORKER_UNKNOWN_CODE_VERSION;
}

/**
 * 两侧版本是否已对齐（= 更新已生效）。
 * 口径与 {@link computeUpdateAvailable} 严格互补，共用同一把尺子：
 * 两边都可比对 且 trim 后相等。`dev` / 缺期望版本一律判「未对齐」。
 */
export function isCodeVersionAligned(
  codeVersion: string | null | undefined,
  expectedVersion: string | null | undefined,
): boolean {
  if (!isComparableCodeVersion(codeVersion)) return false;
  if (!isComparableCodeVersion(expectedVersion)) return false;
  return codeVersion.trim() === expectedVersion.trim();
}

/**
 * GET /workers 出参 `updateAvailable`：是否值得按【更新】。
 * 两侧都可比对且不相等才为 true——`dev`/缺期望版本（未配置 CODE_VERSION 的部署）
 * 一律 false：那里没有「更新到哪个版本」的答案，凭空说「可更新」就是撒谎。
 */
export function computeUpdateAvailable(
  codeVersion: string | null | undefined,
  expectedVersion: string | null | undefined,
): boolean {
  if (!isComparableCodeVersion(codeVersion)) return false;
  if (!isComparableCodeVersion(expectedVersion)) return false;
  return codeVersion.trim() !== expectedVersion.trim();
}
