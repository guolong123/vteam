import { IdGeneratorService, ID_PAD_WIDTH } from './id-generator';

describe('IdGeneratorService（可排序域前缀主键生成）', () => {
  let gen: IdGeneratorService;

  beforeEach(() => {
    gen = new IdGeneratorService();
  });

  describe('nextId：有序性 / 唯一性', () => {
    it('连续调用生成有序唯一 id，且字典序 == 数值序', async () => {
      const ids: string[] = [];
      for (let i = 1; i <= 12; i++) {
        ids.push(await gen.nextId('m'));
      }
      expect(new Set(ids).size).toBe(12);
      // 可排序可游标：字符串排序 == 生成顺序（含 m_10 与 m_9 边界）
      expect([...ids].sort()).toEqual(ids);
      expect(ids[0]).toBe('m_0000000001');
      expect(ids[8]).toBe('m_0000000009');
      expect(ids[9]).toBe('m_0000000010');
      expect(ids[11]).toBe('m_0000000012');
    });

    it('固定宽度零填充 ≤ VARCHAR(64) 主键约定', async () => {
      const id = await gen.nextId('ev');
      expect(id).toMatch(/^ev_\d+$/);
      expect(id.length).toBe('ev_'.length + ID_PAD_WIDTH);
      expect(id.length).toBeLessThanOrEqual(64);
    });

    it('Promise.all 并发调用无重复且有序', async () => {
      const ids = await Promise.all(
        Array.from({ length: 10 }, () => gen.nextId('ev')),
      );
      expect(new Set(ids).size).toBe(10);
      expect([...ids].sort()).toEqual(ids);
    });
  });

  describe('前缀隔离', () => {
    it('m_ 与 ev_ 互不干扰，各自独立计数', async () => {
      const m1 = await gen.nextId('m');
      const ev1 = await gen.nextId('ev');
      const m2 = await gen.nextId('m');
      const ev2 = await gen.nextId('ev');
      expect(m1).toBe('m_0000000001');
      expect(m2).toBe('m_0000000002');
      expect(ev1).toBe('ev_0000000001');
      expect(ev2).toBe('ev_0000000002');
    });
  });

  describe('seed：进程启动续号', () => {
    it('对齐库内已有最大 id 后从下一个序号继续', async () => {
      gen.seed('m', 5);
      expect(await gen.nextId('m')).toBe('m_0000000006');
    });

    it('seed 只升不降，低于当前计数时忽略', async () => {
      await gen.nextId('m'); // → 1
      gen.seed('m', 0); // 不生效
      expect(await gen.nextId('m')).toBe('m_0000000002');
    });
  });
});
