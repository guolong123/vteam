import { IdGeneratorService } from './id-generator';
import { resyncIdPrefix, ResyncIdModel } from './id-resync';

describe('resyncIdPrefix（域主键续号：只统计前缀下纯数字序号）', () => {
  let idGen: IdGeneratorService;

  /** mock Prisma delegate（findMany 只回传 id 行列表）。 */
  const mockModel = (rows: Array<{ id: string }>) => {
    const findMany = jest.fn().mockResolvedValue(rows);
    return { model: { findMany } as unknown as ResyncIdModel, findMany };
  };

  beforeEach(() => {
    idGen = new IdGeneratorService();
  });

  it('findMany 按 `<prefix>_` 前缀过滤 + 仅取 id 列', async () => {
    const { model, findMany } = mockModel([]);

    await resyncIdPrefix(model, 'tl', idGen);

    expect(findMany).toHaveBeenCalledWith({
      where: { id: { startsWith: 'tl_' } },
      select: { id: true },
    });
  });

  it('混合 tl_<数字> + tl_builtin_* 时取数字序号最大值（忽略命名 id）→ 续到 1', async () => {
    const { model } = mockModel([
      { id: 'tl_0000000001' },
      { id: 'tl_0000000010' },
      { id: 'tl_builtin_bash' },
      { id: 'tl_builtin_write' }, // 字典序最大但非数字，原 findFirst desc 会取到它
    ]);

    await resyncIdPrefix(model, 'tl', idGen);

    // seed 到 10 → 下一个 id 应为 tl_0000000011
    expect(await idGen.nextId('tl')).toBe('tl_0000000011');
  });

  it('纯命名 id（a_architect/a_product）→ 不 seed，nextId 从 1 起', async () => {
    const { model } = mockModel([
      { id: 'a_architect' },
      { id: 'a_product' },
    ]);

    await resyncIdPrefix(model, 'a', idGen);

    expect(await idGen.nextId('a')).toBe('a_0000000001');
  });

  it('空表 → 不 seed，nextId 从 1 起', async () => {
    const { model } = mockModel([]);

    await resyncIdPrefix(model, 'sk', idGen);

    expect(await idGen.nextId('sk')).toBe('sk_0000000001');
  });

  it('前缀隔离：a_ 统计不影响 as_/ate_ 前缀', async () => {
    const { model } = mockModel([
      { id: 'a_0000000003' },
      { id: 'as_0000000005' },
      { id: 'ate_0000000007' },
    ]);

    await resyncIdPrefix(model, 'a', idGen);

    // 只有 a_0000000003 参与计数（as_/ate_ 不是 a_ 前缀）
    expect(await idGen.nextId('a')).toBe('a_0000000004');
  });

  it('md_ 前缀 mixed id（数字序号 + 命名 id）→ 取数字最大续号（模型目录 seed 后 8 行）', async () => {
    const { model } = mockModel([
      { id: 'md_0000000003' },
      { id: 'md_0000000008' },
      { id: 'md_named_legacy' }, // 命名 id 不参与续号
    ]);

    await resyncIdPrefix(model, 'md', idGen);

    // seed 到 8 → 下一个 id 应为 md_0000000009
    expect(await idGen.nextId('md')).toBe('md_0000000009');
  });
});
