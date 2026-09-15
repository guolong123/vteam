/**
 * P3 skill 版本存量回填（T0，.omo/plans/learning-mode-private-knowledge.md §4-T0）：
 * 迁移 20260915000000_add_skill_versions 建表后，把每个尚无 v1 历史行的 skill
 * 按 live content/file_meta 记一笔 version=1（幂等：已有 v1 行跳过）。
 *
 * 回填行 id `skv_backfill_<skillId>`（非纯数字尾缀，onModuleInit 的 resyncIdPrefix
 * 只统计 `skv_<数字>`，天然跳过，不干扰后续 `skv_` 续号）。
 *
 * 用法（compose 网络内，DB 宿主机无端口映射）：
 *   docker cp server/prisma/backfill-skill-versions.ts aiagents-compose-server:/app/prisma/
 *   docker exec aiagents-compose-server npx ts-node prisma/backfill-skill-versions.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const inserted = await prisma.$executeRaw`
    INSERT INTO \`skill_versions\` (\`id\`, \`skill_id\`, \`version\`, \`content\`, \`file_meta\`, \`created_by\`, \`created_at\`)
    SELECT CONCAT('skv_backfill_', s.\`id\`), s.\`id\`, 1, s.\`content\`, s.\`file_meta\`, NULL, NOW(3)
    FROM \`skills\` s
    WHERE NOT EXISTS (
      SELECT 1 FROM \`skill_versions\` v WHERE v.\`skill_id\` = s.\`id\` AND v.\`version\` = 1
    )`;
  const [{ total }] = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COUNT(*) AS \`total\` FROM \`skill_versions\` WHERE \`version\` = 1`;
  console.log(`backfill done: inserted=${inserted} v1_total=${total}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
