import { createLedger, embedLedger } from './review-round-ledger';
import { ReviewRoundService } from './review-round.service';
import { ReviewRoundGateService } from './review-round-gate.service';

/**
 * attachNotifier 专项（gate-notifier-wiring）：构造时 notifier 缺省 null，
 * 经 attachNotifier 后装配的 notifier 在收敛时被调用（kind='wake'，
 * 计划员 + 抄 PM 两次调用）。
 * 全程 mock（内存账本 + jest notifier），无 DB。
 */

const MEMBERS = ['tmm_0000000012', 'tmm_0000000009', 'tmm_0000000010'];
const PLANNER = 'tmm_0000000001';
const PM = 'tmm_0000000002';
const CHANNEL = 'ch_0000000001';

const setupUnwired = () => {
  const seed = createLedger({
    round: 2,
    planVersion: { version: 'v0.3', lines: 233, hash: 'a1b2c3d4' },
    planPath: '.opencode/plans/alert-analyzer-fix-iteration-plan.md',
    taskId: 't_0000000001',
    issueId: 'is_0000000007',
    expected: MEMBERS,
    expectedRoles: ['架构视角', '开发视角', '测试视角'],
    timeoutAt: '2026-09-16T00:40:00Z',
  });
  const store = new Map<string, string | null>([
    [
      'is_0000000007',
      embedLedger('评审派发 R2（v0.3，架构/开发/测试三视角）', seed),
    ],
  ]);
  let mutex: Promise<void> = Promise.resolve();
  const lock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = mutex;
    let release!: () => void;
    mutex = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ id: 'is_0000000007' }]),
    issue: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (!store.has(where.id)) return null;
        return { id: where.id, description: store.get(where.id) };
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { description: string };
        }) => {
          store.set(where.id, data.description);
          return { id: where.id, description: data.description };
        },
      ),
    },
  };
  const roundsPrisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) =>
      lock(() => fn(tx)),
    ),
  };
  const readPrisma = {
    issue: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (!store.has(where.id)) return null;
        return { id: where.id, description: store.get(where.id) };
      }),
    },
  };
  const rounds = new ReviewRoundService(roundsPrisma as never);
  // 构造时不传 notifier：走 @Optional() 缺省 null
  const gate = new ReviewRoundGateService(readPrisma as never, rounds);
  const notifier = {
    dispatchAgentMention: jest.fn(async () => undefined),
  };
  const notifyOpts = {
    channelId: CHANNEL,
    plannerMemberId: PLANNER,
    pmMemberId: PM,
    taskId: 't_0000000001',
  };
  return { gate, notifier, notifyOpts };
};

const converge = async (
  gate: ReviewRoundGateService,
  notifyOpts: {
    channelId: string;
    plannerMemberId: string;
    pmMemberId: string;
    taskId: string;
  },
) => {
  for (const [i, m] of MEMBERS.entries()) {
    await gate.recordVerdict(
      'is_0000000007',
      { member: m, verdict: 'APPROVE', msgId: `m_71${i}`, version: 'v0.3' },
      notifyOpts,
    );
  }
};

describe('ReviewRoundGateService.attachNotifier', () => {
  it('缺省 null：收敛照常 complete 但不通知（no-op 保留）', async () => {
    const { gate, notifier, notifyOpts } = setupUnwired();
    await converge(gate, notifyOpts);
    expect(notifier.dispatchAgentMention).not.toHaveBeenCalled();
    const ok = await gate.requestRevision('is_0000000007', PLANNER);
    expect(ok.allowed).toBe(true);
  });

  it('attachNotifier 后收敛调用 dispatchAgentMention：kind=wake + 计划员目标', async () => {
    const { gate, notifier, notifyOpts } = setupUnwired();
    gate.attachNotifier(notifier);
    await converge(gate, notifyOpts);
    expect(notifier.dispatchAgentMention).toHaveBeenCalledTimes(2);
    const calls = (
      notifier.dispatchAgentMention as jest.Mock
    ).mock.calls.map(
      (c) => c[0] as { targetInstanceId: string; kind: string; text: string },
    );
    expect(calls.map((c) => c.targetInstanceId).sort()).toEqual(
      [PLANNER, PM].sort(),
    );
    for (const c of calls) {
      expect(c.kind).toBe('wake');
    }
    const plannerCall = calls.find((c) => c.targetInstanceId === PLANNER);
    expect(plannerCall?.text).toMatch(/R2/);
  });

  it('attachNotifier(null) 可拆卸：拆卸后收敛不再通知', async () => {
    const first = setupUnwired();
    first.gate.attachNotifier(first.notifier);
    first.gate.attachNotifier(null);
    await converge(first.gate, first.notifyOpts);
    expect(first.notifier.dispatchAgentMention).not.toHaveBeenCalled();
  });
});
