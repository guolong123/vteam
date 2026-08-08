import { Injectable } from '@nestjs/common';

/**
 * 可排序域前缀主键生成器（对齐 15 篇 §2.2 主键策略）。
 *
 * 生成格式：`<prefix>_<零填充序号>`，如 `m_0000000001`、`ev_0000000012`。
 *
 * 关键设计：
 * - 序号零填充到固定宽度（ID_PAD_WIDTH=10），保证「字典序 == 数值序」
 *   （m_0000000009 < m_0000000010），游标分页 / SSE since 可直接按字符串比较，
 *   规避非填充方案 m_10 < m_9 的排序陷阱。
 * - 序号来源：本版单机进程内序列（15 篇 §2.2「应用层序号服务，本版单机进程内序列」），
 *   每个前缀独立计数器；JS 单线程事件循环保证 nextId 同步段原子执行，并发调用无重复。
 * - seed(prefix, n)：进程启动时对齐库内该前缀已有最大序号（重启续号），
 *   数据库唯一约束（PRIMARY KEY id）作为最终兜底。
 */
export const ID_PAD_WIDTH = 10;

export interface IdGenerator {
  /** 生成 `<prefix>_<零填充序号>`，数值序 == 字典序。 */
  nextId(prefix: string): Promise<string>;
  /** 对齐某前缀的起始序号（进程启动续号用）。 */
  seed(prefix: string, current: number): void;
}

@Injectable()
export class IdGeneratorService implements IdGenerator {
  private readonly counters = new Map<string, number>();

  /** 初始化某前缀的起始序号，只升不降（对齐库内已有最大 id 时使用）。 */
  seed(prefix: string, current: number): void {
    const existing = this.counters.get(prefix) ?? 0;
    if (current > existing) {
      this.counters.set(prefix, current);
    }
  }

  /**
   * 生成下一个域前缀主键。
   * 同步段（读 + 写 Map）无 await 打断，事件循环内原子，Promise.all 并发安全。
   */
  async nextId(prefix: string): Promise<string> {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(ID_PAD_WIDTH, '0')}`;
  }
}
