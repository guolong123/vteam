/**
 * 回填成员库（37 篇 §4.2 / M2）。
 *
 * 1:1 把旧 `team_members` 行迁成平台成员：
 *   - 每个席位建一条 Member（name = alias，缺省 `<岗位/Agent 名>-<seq>`；重名自动加后缀）
 *   - 回写 `team_members.member_id`、把该席位的私聊频道挂上 `chat_channels.member_id`
 *   - `members.origin_team_member_id` 唯一 ⇒ 脚本幂等，可重复执行
 *
 * 用法：
 *   npx ts-node prisma/backfill-members.ts            # 执行
 *   npx ts-node prisma/backfill-members.ts --dry-run  # 只统计，不写库
 *
 * 跳过条件（输出到报告，人工处理）：
 *   - 席位没有 roleId，且找不到 defaultAgentId 指向该 Agent 的岗位
 *   - 席位 agent 缺失（FK 已保证，不会发生）
 *
 * 注意：本脚本不合并"同一人存在于多群"的重复成员（S1 1:1 策略），后续用成员合并工具整理。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const PAD_WIDTH = 10;

interface Report {
  scanned: number;
  created: number;
  linkedSeats: number;
  linkedChannels: number;
  skippedNoRole: Array<{ teamMemberId: string; agentId: string }>;
  nameAdjustments: Array<{
    teamMemberId: string;
    wanted: string;
    used: string;
  }>;
}

function memberIdFromSeat(seatId: string): string | null {
  const suffix = seatId.startsWith('tmm_') ? seatId.slice(4) : '';
  if (!/^\d+$/.test(suffix)) return null;
  return `mbr_${suffix.padStart(PAD_WIDTH, '0')}`;
}

async function uniqueName(wanted: string): Promise<string> {
  const base = wanted.trim() || '成员';
  let candidate = base;
  let index = 1;
  while (index <= 1000) {
    const exists = await prisma.member.findUnique({
      where: { name: candidate },
      select: { id: true },
    });
    if (!exists) return candidate;
    index += 1;
    candidate = `${base}-${index}`;
  }
  throw new Error(`无法为「${base}」生成唯一成员名`);
}

async function main() {
  const report: Report = {
    scanned: 0,
    created: 0,
    linkedSeats: 0,
    linkedChannels: 0,
    skippedNoRole: [],
    nameAdjustments: [],
  };

  // 存量席位可能引用已删除的模型/Worker（历史脏数据）。直接复制会触发
  // members.default_model_id / preferred_worker_id 外键失败，导致整批回填中断；
  // 先筛出真实存在的引用，失效的置空（这些引用本身已不可用）。
  const seatModelRefs = await prisma.teamMember.findMany({
    where: { memberId: null, overrideModelId: { not: null } },
    select: { overrideModelId: true },
    distinct: ['overrideModelId'],
  });
  const seatWorkerRefs = await prisma.teamMember.findMany({
    where: { memberId: null, preferredWorkerId: { not: null } },
    select: { preferredWorkerId: true },
    distinct: ['preferredWorkerId'],
  });
  const validModelIds = new Set(
    (
      await prisma.model.findMany({
        where: {
          id: {
            in: seatModelRefs
              .map((s) => s.overrideModelId)
              .filter((id): id is string => !!id),
          },
        },
        select: { id: true },
      })
    ).map((m) => m.id),
  );
  const validWorkerIds = new Set(
    (
      await prisma.worker.findMany({
        where: {
          id: {
            in: seatWorkerRefs
              .map((s) => s.preferredWorkerId)
              .filter((id): id is string => !!id),
          },
        },
        select: { id: true },
      })
    ).map((w) => w.id),
  );

  const seats = await prisma.teamMember.findMany({
    where: { memberId: null },
    include: {
      team: { select: { id: true, name: true, createdBy: true } },
      agent: { select: { id: true, name: true } },
      role: { select: { id: true, key: true, name: true } },
    },
    orderBy: { id: 'asc' },
  });

  for (const seat of seats) {
    report.scanned += 1;

    let roleId = seat.roleId ?? null;
    if (!roleId) {
      const role = await prisma.agentRole.findFirst({
        where: { defaultAgentId: seat.agentId },
        select: { id: true },
      });
      roleId = role?.id ?? null;
    }
    if (!roleId) {
      report.skippedNoRole.push({
        teamMemberId: seat.id,
        agentId: seat.agentId,
      });
      continue;
    }

    // 存量回填按「席位别名（团队名·席位尾号）」命名：同一岗位在多个团队各有一个席位时
    // 左栏私聊/成员库不再出现一串同名成员，也避免跨团队重名唯一键冲突。
    const baseName =
      seat.alias?.trim() ||
      `${seat.role?.name ?? seat.agent?.name ?? '成员'}-${seat.seq}`;
    const wantedName = `${baseName}（${seat.team.name.slice(0, 40)}）`;
    const name = DRY_RUN ? wantedName : await uniqueName(wantedName);
    if (name !== wantedName) {
      report.nameAdjustments.push({
        teamMemberId: seat.id,
        wanted: wantedName,
        used: name,
      });
    }

    const memberId = memberIdFromSeat(seat.id);
    if (!memberId) {
      report.skippedNoRole.push({
        teamMemberId: seat.id,
        agentId: seat.agentId,
      });
      continue;
    }

    if (DRY_RUN) {
      report.created += 1;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.member.create({
        data: {
          id: memberId,
          name,
          defaultRoleId: roleId as string,
          agentId: seat.agentId,
          defaultModelId:
            seat.overrideModelId && validModelIds.has(seat.overrideModelId)
              ? seat.overrideModelId
              : null,
          preferredWorkerId:
            seat.preferredWorkerId && validWorkerIds.has(seat.preferredWorkerId)
              ? seat.preferredWorkerId
              : null,
          privateWorkDir: null,
          status: 'active',
          description: `由团队「${seat.team.name}」的席位 ${seat.id} 回填`,
          originTeamMemberId: seat.id,
          createdBy: seat.team.createdBy,
        },
      });
      await tx.teamMember.update({
        where: { id: seat.id },
        data: { memberId },
      });
      const channels = await tx.chatChannel.updateMany({
        where: { teamMemberId: seat.id, type: 'private' },
        data: { memberId },
      });
      report.linkedChannels += channels.count;
    });
    report.created += 1;
    report.linkedSeats += 1;
  }

  console.log(
    JSON.stringify(
      {
        dryRun: DRY_RUN,
        scanned: report.scanned,
        created: report.created,
        linkedSeats: report.linkedSeats,
        linkedChannels: report.linkedChannels,
        skippedNoRole: report.skippedNoRole,
        nameAdjustments: report.nameAdjustments,
      },
      null,
      2,
    ),
  );
  if (report.skippedNoRole.length > 0) {
    console.error(
      `\n⚠ ${report.skippedNoRole.length} 个席位缺少岗位，未回填；请先补齐 team_members.role_id 后重跑。`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
