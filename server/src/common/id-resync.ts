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

/**
 * P2021 fail-open 共用实现（主键续号 / requestId 续号共用）：
 * 表尚未创建时上抛会让 Nest onModuleInit 崩溃 → restart 循环 → 连带 worker 启动注入
 * fetch failed（k8s 实测）。故不阻塞启动，后台轮询到表就绪再补 seed；若不补，计数器停留 0，
 * 迁移 seed 出的数字 id 会让首个插入撞 P2002。
 */
function startP2021Retry(
  fetchRows: () => Promise<unknown>,
  apply: (rows: unknown) => void,
  label: string,
  cause: Error,
): void {
  console.warn(
    `[id-resync] 表不存在（P2021），${label} 续号转后台重试（不阻塞启动）: ${cause.message}`,
  );
  let attempts = 0;
  const timer = setInterval(() => {
    void (async () => {
      attempts += 1;
      try {
        apply(await fetchRows());
        clearInterval(timer);
        console.warn(
          `[id-resync] ${label} 续号已随表就绪补成功（第 ${attempts} 次重试）`,
        );
      } catch (retryErr) {
        if (attempts >= P2021_RETRY_MAX_ATTEMPTS) {
          clearInterval(timer);
          console.warn(
            `[id-resync] ${label} 续号后台重试耗尽（${P2021_RETRY_MAX_ATTEMPTS} 次），下次重启续号自愈: ${(retryErr as Error).message}`,
          );
        }
      }
    })();
  }, P2021_RETRY_INTERVAL_MS);
  timer.unref?.();
}

export async function resyncIdPrefix(
  model: ResyncIdModel,
  prefix: string,
  idGen: Pick<IdGenerator, 'seed'>,
): Promise<void> {
  const fetchRows = () =>
    model.findMany({
      where: { id: { startsWith: `${prefix}_` } },
      select: { id: true },
    });
  let rows: unknown;
  try {
    rows = await fetchRows();
  } catch (err) {
    if ((err as { code?: string })?.code !== 'P2021') {
      throw err;
    }
    startP2021Retry(
      fetchRows,
      (lateRows) =>
        applyResync(lateRows as Array<{ id: string }>, prefix, idGen),
      prefix,
      err as Error,
    );
    return;
  }
  applyResync(rows as Array<{ id: string }>, prefix, idGen);
}

/**
 * 域主键前缀续号的目标模型接口，但按 `requestId` 列（非主键）过滤——
 * 对应 `agent_questions.request_id` 这类 `@unique` 唯一约束列（非 PK）。
 */
export interface ResyncRequestIdModel {
  findMany(args: {
    where: { requestId: { startsWith: string } };
    select: { requestId: true };
  }): Promise<unknown>;
}

/**
 * 落地 requestId 续号：取 `<requestIdPrefix>_` 前缀行中**纯数字**尾段最大值，
 * seed 进 `idPrefix` 计数器（生成侧 `nextId(idPrefix)` 的数字尾段与
 * `<requestIdPrefix>_<同一数字>` 一一对应）。命名尾段、空尾段、超出安全整数的
 * 超长尾段跳过（超长值无法保持 ID_PAD_WIDTH 零填充格式）；max=0 时不 seed。
 */
function applyRequestIdResync(
  rows: Array<{ requestId: string }>,
  requestIdPrefix: string,
  idPrefix: string,
  idGen: Pick<IdGenerator, 'seed'>,
): void {
  let max = 0;
  for (const row of rows) {
    if (!row.requestId.startsWith(`${requestIdPrefix}_`)) {
      continue; // 非本前缀行（per_/que_ 等）不参与，避免按偏移切片切出杂散数字
    }
    const tail = row.requestId.slice(requestIdPrefix.length + 1);
    if (!/^\d+$/.test(tail)) {
      continue;
    }
    const seq = Number(tail);
    if (!Number.isSafeInteger(seq)) {
      continue;
    }
    if (seq > max) {
      max = seq;
    }
  }
  if (max > 0) {
    idGen.seed(idPrefix, max);
  }
}

/**
 * 按 requestId 列前缀重新同步计数器（进程启动续号）。
 *
 * 修复：`que` 计数器重启归零，而 `agent_questions.request_id` 是 `@unique`
 * （agent_questions_request_id_key），重启后重发 `que_platform_0000000001` 撞既有行
 * → P2002，secret question 创建反复失败直到计数器烧过存量最大值。
 * P2021（表不存在）走与 resyncIdPrefix 相同的 fail-open 后台补续号。
 */
export async function resyncRequestIdPrefix(
  model: ResyncRequestIdModel,
  idPrefix: string,
  requestIdPrefix: string,
  idGen: Pick<IdGenerator, 'seed'>,
): Promise<void> {
  const fetchRows = () =>
    model.findMany({
      where: { requestId: { startsWith: `${requestIdPrefix}_` } },
      select: { requestId: true },
    });
  const label = `${idPrefix}→${requestIdPrefix}`;
  let rows: unknown;
  try {
    rows = await fetchRows();
  } catch (err) {
    if ((err as { code?: string })?.code !== 'P2021') {
      throw err;
    }
    startP2021Retry(
      fetchRows,
      (lateRows) =>
        applyRequestIdResync(
          lateRows as Array<{ requestId: string }>,
          requestIdPrefix,
          idPrefix,
          idGen,
        ),
      label,
      err as Error,
    );
    return;
  }
  applyRequestIdResync(
    rows as Array<{ requestId: string }>,
    requestIdPrefix,
    idPrefix,
    idGen,
  );
}
