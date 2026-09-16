/**
 * 幂等回填脚本：为 `category IS NULL` 的 Artifact 按标题关键词有序规则回填 category。
 *
 * 规则来源：`.omo/plans/docs-artifacts-merge.md` Appendix A（首命中胜出，
 * 命中不了留 NULL；`其他` 只许人/Agent 显式选，本脚本永不写入）。
 *
 * 用法（lone script，不入任何 NestJS module / package.json / CI，手动运行）：
 *   npx ts-node server/scripts/backfill-artifact-category.ts --dry-run  # 只打印，不写库
 *   npx ts-node server/scripts/backfill-artifact-category.ts            # 实跑
 * DB 无直连路由时（如宿主机 → compose MySQL），按 T1 既定模式进容器跑：
 *   docker cp server/scripts/backfill-artifact-category.ts aiagents-compose-server:/tmp/
 *   docker exec aiagents-compose-server npx ts-node --transpile-only \
 *     --compiler-options '{"module":"commonjs","moduleResolution":"node"}' /tmp/backfill-artifact-category.ts --dry-run
 *
 * 连接方式：prisma 直连（抄 `server/prisma/seed.ts` 的 `new PrismaClient()` 自包含模式，
 * 不 import `src/` 下任何东西——生产 runner 镜像无 `src/`）。
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** 附录 A 词表（展示另有 `全部`/`未分类`，均非 DB 值；`其他` 永不回填）。 */
const BACKFILL_CATEGORIES = ['需求', '设计', '实现', '测试用例', '测试报告', '运维'] as const;
type BackfillCategory = (typeof BACKFILL_CATEGORIES)[number];

/**
 * 附录 A 有序规则（first-match-wins）。顺序即优先级，改动即改语义：
 * 1. 标题含 `测试用例|用例` → 测试用例
 * 2. 标题含 `测试报告|测试.*报告|验收报告` → 测试报告
 * 3. 标题含 `需求|PRD|规格` → 需求
 * 4. 标题含 `设计|架构|ADR|方案` → 设计
 * 5. 标题含 `实现|开发说明|实现说明` → 实现
 * 6. 标题含 `运维|部署|上线` → 运维
 * 7. 当前版本 contentRef 以 `.tsx` / `.prototype.json` 结尾 → 设计（原型归设计类存放）
 * 8. 其余 → NULL（未分类，不写 `其他`）
 */
function classify(title: string, contentRef: string | null): BackfillCategory | null {
  const t = title ?? '';
  if (/测试用例|用例/.test(t)) return '测试用例';
  if (/测试报告|验收报告|测试.*报告/.test(t)) return '测试报告';
  if (/需求|PRD|规格/i.test(t)) return '需求';
  if (/设计|架构|ADR|方案/i.test(t)) return '设计';
  if (/实现|开发说明|实现说明/.test(t)) return '实现';
  if (/运维|部署|上线/.test(t)) return '运维';
  if (contentRef != null && (contentRef.endsWith('.tsx') || contentRef.endsWith('.prototype.json'))) return '设计';
  return null;
}

async function assertCategoryColumnExists(): Promise<void> {
  // 物理表名是 `artifacts`（schema `@@map("artifacts")`），`DESCRIBE Artifact`
  // 会报 P1014——此处用物理名，前置断言语义不变（列存在即过）。
  const rows = (await prisma.$queryRawUnsafe(
    'SHOW COLUMNS FROM `artifacts` LIKE \'category\'',
  )) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    console.error(
      'FATAL: column `category` missing on table `artifacts` — ' +
        'apply migration 20260919000000_add_artifact_category first, aborting.',
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  await assertCategoryColumnExists();

  // 只读 `category IS NULL` 行：已有值永不覆盖（即使标题已改判属他类）。
  // contentRef 在 ArtifactVersion（当前版本），故 include versions。
  const pending = await prisma.artifact.findMany({
    where: { category: null },
    select: {
      id: true,
      title: true,
      currentVersion: true,
      versions: { select: { version: true, contentRef: true } },
    },
  });

  const buckets = new Map<BackfillCategory, string[]>();
  for (const row of pending) {
    const current = row.versions.find((v) => v.version === row.currentVersion) ?? null;
    const hit = classify(row.title, current?.contentRef ?? null);
    if (hit == null) continue;
    const list = buckets.get(hit) ?? [];
    list.push(row.id);
    buckets.set(hit, list);
  }

  if (dryRun) {
    let total = 0;
    for (const [category, ids] of buckets) {
      console.log(`will update: ${category}: ${ids.length}`);
      total += ids.length;
    }
    console.log(`will update: TOTAL: ${total}`);
    return;
  }

  let total = 0;
  for (const [category, ids] of buckets) {
    // 二次守卫 `category: null`：并发/复跑下已有值行不受影响。
    const res = await prisma.artifact.updateMany({
      where: { id: { in: ids }, category: null },
      data: { category },
    });
    console.log(`updated: ${category}: ${res.count}`);
    total += res.count;
  }
  console.log(`updated: TOTAL: ${total}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
