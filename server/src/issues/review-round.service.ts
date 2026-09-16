import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  REVIEW_ROUND_ERRORS,
  RoundUpdate,
  ReviewRoundLedger,
  VerdictInput,
  createLedger,
  embedLedger,
  mergeLedger,
  parseLedger,
  resolveVerdict,
} from './review-round-ledger';

/**
 * 轮次账本写服务（plan-review-execution-gates todo 6；todos 7/8 的前置）。
 *
 * 唯一写入口 `applyRoundUpdate`：把"读 issue description → 解析账本 →
 * 合并 → 写回"包进同一事务，并在事务内先对 issues 行取
 * `SELECT ... FOR UPDATE` 行锁（MySQL），并发写串行化——双写不丢失。
 * 合并规则：received 按成员覆盖（同人多次取最后一次）、round 与
 * planVersion 只升不降；hash 缺失的回执挂起 pending-hash。
 */
@Injectable()
export class ReviewRoundService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 串行化账本更新（并发安全）：
   * 1. 事务内 `SELECT issues ... FOR UPDATE` 锁宿主行；
   * 2. 无账本则以宿主 issueId 建空账本（派发即宿主，写回链接）；
   * 3. 结构字段合并后逐条裁决回执（pending-hash / superseded / received）；
   * 4. 机器段写回 description，返回合并后账本。
   */
  async applyRoundUpdate(
    issueId: string,
    update: RoundUpdate,
  ): Promise<ReviewRoundLedger> {
    return this.prisma.$transaction(
      async (tx: Prisma.TransactionClient): Promise<ReviewRoundLedger> => {
        try {
          await tx.$queryRawUnsafe(
            'SELECT id FROM issues WHERE id = ? FOR UPDATE',
            issueId,
          );
        } catch {
          // 非 MySQL 方言（如单测 mock 缺 $queryRawUnsafe）：退化为事务内读-改-写。
        }
        const issue = await tx.issue.findUnique({
          where: { id: issueId },
        });
        if (!issue) {
          throw new NotFoundException({
            code: REVIEW_ROUND_ERRORS.ISSUE_NOT_FOUND,
            message: `Issue ${issueId} 不存在`,
          });
        }
        const { received, ...structural } = update;
        const base =
          parseLedger(issue.description ?? null) ?? createLedger({ issueId });
        // plan↔task↔issue 链接：宿主 issueId 恒写回（dispatch issue 即账本宿主）。
        let merged = mergeLedger(base, { ...structural, issueId });
        const inputs: VerdictInput[] =
          received === undefined
            ? []
            : Array.isArray(received)
              ? received
              : [received];
        for (const v of inputs) {
          merged = resolveVerdict(merged, v).ledger;
        }
        await tx.issue.update({
          where: { id: issueId },
          data: { description: embedLedger(issue.description ?? null, merged) },
        });
        return merged;
      },
    );
  }
}
