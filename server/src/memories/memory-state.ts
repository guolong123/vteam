import { ForbiddenException } from '@nestjs/common';
import type { Memory } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MEMORY_ERRORS, MEMORY_LEVELS } from './memory.constants';

/**
 * 记忆归档/合并的**共享纯状态口径**（memory-enhancement Todo 8a）。
 *
 * 为什么是纯 helper 而不是复用 `MemoriesService.remove()`：
 * - 鉴权口径本质不同。REST 侧按**人类用户**判权（`team_user_members` 成员 或 平台管理员，
 *   见 memories.service.ts `assertRowWritable`），MCP 侧调用方是**团队成员实例**（tmm_），
 *   且 Agent 整理入口只允许 team 级（决策⑤：global/role 行 → 403，管理员身份对 Agent 无意义）。
 * - `MemoriesModule` 未导出 `MemoriesService`（注入需改 memories.module.ts，本 todo 越界）。
 * 故把「归档=软删」这一**唯一写入语义**下沉到此处，REST `remove()` 与 MCP `memoryArchive`
 * 共用同一出口，避免两条归档路径语义漂移。
 */

/** scope 守卫所需的最小行字段（不取整行，保持 helper 与 Prisma 行类型解耦）。 */
export type MemoryScopeRow = {
  level: string;
  teamId: string | null;
};

/**
 * team 级归属门（Agent 整理入口专用）：仅 `level === 'team'` 且 `row.teamId` 为
 * 调用方团队才放行；global / role / 存量 task 级 / 其他团队一律 403 MEMORY_FORBIDDEN。
 * 纯函数（不查库）：行归属判定与调用方团队解析分离，便于逐条断言。
 */
export function assertTeamScopedMemoryRow(
  row: MemoryScopeRow,
  callerTeamId: string,
): void {
  if (row.level !== MEMORY_LEVELS.team || row.teamId !== callerTeamId) {
    throw new ForbiddenException({
      code: MEMORY_ERRORS.MEMORY_FORBIDDEN,
      message:
        '仅可整理本团队的 team 级记忆（global / role 级记忆不在 Agent 整理范围，请交由平台管理员处理）',
    });
  }
}

/**
 * 归档（软删）唯一写出口：写 `deletedAt`——与 REST `DELETE /memories/:id` 同一语义，
 * 行仍在库中（可恢复），仅从检索（`deletedAt: null` 过滤）与自动注入中消失。
 * **不硬删**：`purge` 仅暴露给人工确认路径，Agent 侧无此入口。
 */
export async function archiveMemoryRow(
  prisma: PrismaService,
  id: string,
  archivedAt: Date = new Date(),
): Promise<Memory> {
  return prisma.memory.update({
    where: { id },
    data: { deletedAt: archivedAt },
  });
}