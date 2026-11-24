import { createHash } from 'crypto';

/**
 * 空间注册令牌（M4 单令牌安装）。
 *
 * 一个随机令牌 `wst_<hex>` 直接绑定一个工作空间：worker 只需携带它
 * （`X-Worker-Token`），服务端按 SHA-256 反查空间，无需再传
 * `WORKSPACE_ID` 与独立的 `WORKER_JOIN_TOKEN`。
 *
 * - 存储：`Workspace.workerJoinTokenHash`（历史列名，语义已统一为空间注册令牌）；
 * - 轮换：重新签发即覆盖 hash，旧令牌立即失效（已注册 worker 的运行时 tokenHash 不受影响）。
 */
export function hashWorkerSpaceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 按令牌反查空间 id；无效/未配置/已归档 → undefined。
 * 使用原生 prisma（无租户上下文时中间件透传），Workspace 模型本身不受空间过滤。
 */
export async function resolveWorkspaceByWorkerToken(
  prisma: { workspace: { findFirst: (args: unknown) => Promise<unknown> } },
  token: string | undefined | null,
): Promise<string | undefined> {
  const raw = token?.trim();
  if (!raw) return undefined;
  const row = (await prisma.workspace.findFirst({
    where: { workerJoinTokenHash: hashWorkerSpaceToken(raw), status: 'active' },
    select: { id: true },
  })) as { id?: string } | null;
  return row?.id;
}
