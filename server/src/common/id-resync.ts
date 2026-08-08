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
export async function resyncIdPrefix(
  model: ResyncIdModel,
  prefix: string,
  idGen: Pick<IdGenerator, 'seed'>,
): Promise<void> {
  const rows = (await model.findMany({
    where: { id: { startsWith: `${prefix}_` } },
    select: { id: true },
  })) as Array<{ id: string }>;

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
