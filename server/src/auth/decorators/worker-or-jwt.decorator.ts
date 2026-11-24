import { SetMetadata } from '@nestjs/common';

/**
 * 双通道鉴权标记：该端点允许「用户 JWT」或「X-Worker-Token（worker 注入拉取）」。
 *
 * 与旧 `@Public()` 的区别：`@Public()` 会让全局 JwtAuthGuard 完全跳过认证，
 * 导致 WorkspaceGuard 无法解析租户上下文（用户/worker 都拿不到 `req.user`），
 * 列表类端点因此返回**所有空间**数据（M2 隔离缺口）。
 *
 * 新语义：
 * - 全局 JwtAuthGuard 命中本标记时：先校验 X-Worker-Token（有效则放行并标记
 *   `req.workerToken`），否则回落到 Bearer JWT 校验 → `req.user` 可用；
 * - WorkspaceGuard 随后正常解析空间：JWT → 用户当前空间；worker → 按
 *   `x-worker-id` 查该 worker 归属空间，注入租户上下文。
 */
export const WORKER_OR_JWT_KEY = 'workerOrJwtAllowed';

export const WorkerOrJwtAllowed = () => SetMetadata(WORKER_OR_JWT_KEY, true);
