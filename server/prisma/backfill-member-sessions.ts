/**
 * 回填全局会话（37 篇 D4 / P3）。
 *
 * 目标：让已存在的成员在开启 `SESSION_SCOPE=member` 前拥有 `sessions.member_key`，
 * 且尽量**复用最近的席位会话**（保留引擎上下文，避免开开关后所有成员被重置一次）。
 *
 * 规则（幂等）：
 *   - 已有 member_key 的成员跳过；
 *   - 从该成员所有席位的 team-mode 会话（task_id IS NULL）里按
 *     last_activity_at DESC, updated_at DESC 取最近一条，认领为成员全局会话：
 *       写 member_id / member_key=member_id / seat_id / current_team_id；
 *   - 没有历史会话的成员不预建（首次派发由 ensureMemberSession 即建即用）。
 *
 * 不做什么：
 *   - 不迁移/删除旧席位会话（消息历史挂在 channel 上，不受影响）；
 *   - 不合并同一成员多个席位的历史引擎上下文（只认领最近一条，其余保持不动，
 *     后续如需可做显式合并工具）；
 *   - 不修改 session_turns（新表尚无历史数据）。
 *
 * 用法：
 *   npx ts-node prisma/backfill-member-sessions.ts            # 执行
 *   npx ts-node prisma/backfill-member-sessions.ts --dry-run  # 只统计
 *
 * 前置：已应用迁移 20261106190000_global_session（sessions.member_key 唯一索引）。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

interface Report {
  scanned: number;
  adopted: number;
  skippedAlready: number;
  skippedNoSeat: number;
  skippedNoSession: number;
  adoptedRows: Array<{
    memberId: string;
    memberName: string;
    sessionId: string;
    teamId: string | null;
    seatId: string | null;
  }>;
}

async function main() {
  const report: Report = {
    scanned: 0,
    adopted: 0,
    skippedAlready: 0,
    skippedNoSeat: 0,
    skippedNoSession: 0,
    adoptedRows: [],
  };
  let cursor: string | undefined;
  const batch = 100;

  for (;;) {
    const members = await prisma.member.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: batch,
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
    });
    if (members.length === 0) break;
    cursor = members[members.length - 1].id;

    for (const member of members) {
      report.scanned += 1;
      const existing = await prisma.session.findUnique({
        where: { memberKey: member.id },
        select: { id: true },
      });
      if (existing) {
        report.skippedAlready += 1;
        continue;
      }
      const seats = await prisma.teamMember.findMany({
        where: { memberId: member.id },
        select: { id: true, teamId: true },
      });
      if (seats.length === 0) {
        report.skippedNoSeat += 1;
        continue;
      }
      const sessions = await prisma.session.findMany({
        where: {
          teamMemberId: { in: seats.map((s) => s.id) },
          taskId: null,
          memberKey: null,
        },
        orderBy: [{ lastActivityAt: 'desc' }, { updatedAt: 'desc' }],
        take: 1,
        select: {
          id: true,
          teamId: true,
          teamMemberId: true,
          lastActivityAt: true,
        },
      });
      const picked = sessions[0];
      if (!picked) {
        report.skippedNoSession += 1;
        continue;
      }
      report.adopted += 1;
      report.adoptedRows.push({
        memberId: member.id,
        memberName: member.name,
        sessionId: picked.id,
        teamId: picked.teamId,
        seatId: picked.teamMemberId,
      });
      if (DRY_RUN) continue;
      try {
        await prisma.session.update({
          where: { id: picked.id },
          data: {
            memberId: member.id,
            memberKey: member.id,
            seatId: picked.teamMemberId,
            currentTeamId: picked.teamId,
          },
        });
      } catch (err) {
        // P2002：并发/重复执行时另一进程已认领 → 跳过即可（幂等）
        if ((err as { code?: string })?.code === 'P2002') {
          report.skippedAlready += 1;
          report.adopted -= 1;
          report.adoptedRows.pop();
          continue;
        }
        throw err;
      }
    }
  }

  console.log(`\n[backfill-member-sessions] ${DRY_RUN ? 'DRY-RUN' : 'DONE'}`);
  console.log(
    `扫描成员 ${report.scanned}；认领会话 ${report.adopted}；` +
      `已有 member_key ${report.skippedAlready}；无席位 ${report.skippedNoSeat}；` +
      `无历史会话 ${report.skippedNoSession}`,
  );
  if (report.adoptedRows.length > 0) {
    console.log('认领明细：');
    for (const row of report.adoptedRows) {
      console.log(
        `  ${row.memberId} ${row.memberName} → ${row.sessionId} ` +
          `(team=${row.teamId ?? '-'}, seat=${row.seatId ?? '-'})`,
      );
    }
  }
  if (DRY_RUN) {
    console.log('\n（dry-run：未写库；去掉 --dry-run 执行）');
  }
}

main()
  .catch((err) => {
    console.error('[backfill-member-sessions] 失败：', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
