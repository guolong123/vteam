/**
 * Worker 控制面常量（T7）。
 * 心跳间隔与离线判定对齐架构决策 D1：10s 心跳 × 3 周期 = 30s 超时判 offline（09 篇 §5.3）。
 */

/** X-Worker-Token 鉴权 header（worker 与用户 JWT 隔离，架构决策 D1）。 */
export const WORKER_TOKEN_HEADER = 'x-worker-token';

/** 部署默认 worker token（process.env.WORKER_TOKEN 未配置时，T7 验收约定的 fallback）。 */
export const DEFAULT_WORKER_TOKEN = 'dev-worker-token';

/** 心跳间隔 ms（与 worker 侧默认一致，见 worker/src/config.ts heartbeatIntervalMs）。 */
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;

/** 离线判定阈值 ms：10s 心跳 × 3 周期 = 30s 未收到即判 offline。 */
export const WORKER_OFFLINE_TIMEOUT_MS = 30_000;

export const WORKER_STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  /** 心跳上报 health=degraded：存活但降权（调度器排后），不改变离线判定。 */
  DEGRADED: 'degraded',
} as const;

export type WorkerStatus = (typeof WORKER_STATUS)[keyof typeof WORKER_STATUS];

export const WORKER_ERRORS = {
  WORKER_NOT_FOUND: 'WORKER_NOT_FOUND',
  TOKEN_INVALID: 'WORKER_TOKEN_INVALID',
  NOT_IMPLEMENTED: 'WORKER_LIFECYCLE_NOT_IMPLEMENTED',
  /**
   * DELETE /workers/:id 防护：仅 offline 可物理删除（防运行中误删）。
   * online/degraded 删除 → 409，先经 shutdown/下线再删。
   */
  WORKER_ONLINE_NOT_REMOVABLE: 'WORKER_ONLINE_NOT_REMOVABLE',
  /**
   * POST /workers/:id/update 防护：离线 worker 收不到更新指令——指令只在心跳响应里下发，
   * 离线的 worker 没有心跳可取，排队等于让 UI 显示「已下发」而永远不发生。409。
   */
  WORKER_OFFLINE_UPDATE_UNREACHABLE: 'WORKER_OFFLINE_UPDATE_UNREACHABLE',
  /**
   * POST /workers/:id/update：server env `CODE_VERSION` 未配置 → 期望版本未知，
   * 没有「更新到哪个版本」的答案。409（部署态问题，非请求格式问题）。
   */
  WORKER_UPDATE_NO_EXPECTED_VERSION: 'WORKER_UPDATE_NO_EXPECTED_VERSION',
} as const;

/** tokenHash bcrypt 轮数，与 auth.service.ts BCRYPT_ROUNDS（10）保持一致。 */
export const WORKER_TOKEN_BCRYPT_ROUNDS = 10;
