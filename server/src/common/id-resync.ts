import { IdGenerator } from './id-generator';

/**
 * 域主键前缀续号的目标模型接口（Prisma delegate 结构兼容，MySQL/SQLite 双库通用）。
 * 只需 findMany：按 `<prefix>_` 前缀过滤 + 仅取 id 列。
 */
export interface ResyncIdModel {
  findMany(args: {
    where: { id: { startsWith: string } };
    select: { id: true };
  }): Promise<unknown>;
}

/**
 * 按前缀重新同步域主键计数器（进程启动续号）。
 *
 * 修复系统性缺陷：原实现 `findFirst({ orderBy: { id: 'desc' } })` 取**字典序最大** id 后
 * parseInt——表内混入命名/builtin id（tl_builtin_bash、a_architect）时字典序更大
 * （'b' > '0'），parseInt 得 NaN → seed 失败 → 计数器从 0 起 → 下次 nextId 生成
 * `<prefix>_0000000001` 撞库中已有主键 → 500（Unique constraint failed on PRIMARY，
 * 注册 ketacli 实测复现）。
 *
 * 新逻辑：只取 `<prefix>_` 前缀行，JS 侧解析**纯数字**序号取 max（命名/builtin id 跳过），
 * 只统计该前缀下的数字序号，忽略 tl_builtin_* / a_architect 等命名 id。
 */
/**
 * 落地续号：取 `<prefix>_` 前缀行中**纯数字**序号最大值 seed 进计数器
 * （命名/builtin id 跳过；max=0 时不 seed，维持计数器初始态）。
 */
function applyResync(
  rows: Array<{ id: string }>,
  prefix: string,
  idGen: Pick<IdGenerator, 'seed'>,
): void {
  let max = 0;
  for (const row of rows) {
    const tail = row.id.slice(prefix.length + 1);
    if (!/^\d+$/.test(tail)) {
      continue; // 命名/builtin id（tl_builtin_*、a_architect）不参与续号
    }
    const seq = Number(tail);
    if (seq > max) {
      max = seq;
    }
  }
  if (max > 0) {
    idGen.seed(prefix, max);
  }
}

/** P2021（表不存在）后台补续号：3s × 40 次 ≈ 2 分钟，覆盖 init Job 迁移窗口。 */
const P2021_RETRY_INTERVAL_MS = 3000;
const P2021_RETRY_MAX_ATTEMPTS = 40;

export async function resyncIdPrefix(
  model: ResyncIdModel,
  prefix: string,
  idGen: Pick<IdGenerator, 'seed'>,
): Promise<void> {
  let rows: Array<{ id: string }>;
  try {
    rows = (await model.findMany({
      where: { id: { startsWith: `${prefix}_` } },
      select: { id: true },
    })) as Array<{ id: string }>;
  } catch (err) {
    // P2021 = 表尚未创建：K8s 下 server 可能先于 init Job 的迁移就绪（启动竞态）。
    // 此处上抛 → Nest onModuleInit 崩溃 → restart 循环 → 连带 worker 启动注入
    // fetch failed（k8s 实测 4 次重启）。故 fail-open 不阻塞启动，后台轮询到
    // 表就绪再补 seed；若不补，计数器停留 0，迁移 seed 出的数字 id 会让首个
    // 插入撞 P2002。非 P2021 错误保持既有行为（向上抛）。
    if ((err as { code?: string })?.code !== 'P2021') {
      throw err;
    }
    console.warn(
      `[id-resync] 表不存在（P2021），${prefix} 续号转后台重试（不阻塞启动）: ${(err as Error).message}`,
    );
    let attempts = 0;
    const timer = setInterval(() => {
      void (async () => {
        attempts += 1;
        try {
          const lateRows = (await model.findMany({
            where: { id: { startsWith: `${prefix}_` } },
            select: { id: true },
          })) as Array<{ id: string }>;
          applyResync(lateRows, prefix, idGen);
          clearInterval(timer);
          console.warn(
            `[id-resync] ${prefix} 续号已随表就绪补成功（第 ${attempts} 次重试）`,
          );
        } catch (retryErr) {
          if (attempts >= P2021_RETRY_MAX_ATTEMPTS) {
            clearInterval(timer);
            console.warn(
              `[id-resync] ${prefix} 续号后台重试耗尽（${P2021_RETRY_MAX_ATTEMPTS} 次），下次重启续号自愈: ${(retryErr as Error).message}`,
            );
          }
        }
      })();
    }, P2021_RETRY_INTERVAL_MS);
    timer.unref?.();
    return;
  }

  applyResync(rows, prefix, idGen);
}
