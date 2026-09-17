import { createLedger, embedLedger } from './review-round-ledger';
import { ReviewRoundService } from './review-round.service';
import {
  REVIEW_ROUND_GATE_ERRORS,
  REVIEW_ROUND_TIMEOUT_MS,
  type ConvergenceNotifier,
  ReviewRoundGateService,
} from './review-round-gate.service';

/**
 * 收敛门 failing-first（plan-review-execution-gates todo 7；docs 33 §3.3-§3.4）。
 *
 * 先写断言、后写实现：本文件落盘时 `review-round-gate.service.ts`
 * 尚不存在，首跑必红（Cannot find module），实现后转绿。
 * 全程复用 todo 6 的 `applyRoundUpdate` 串行写，不复制账本逻辑。
 */

const MEMBERS = ['tmm_0000000012', 'tmm_0000000009', 'tmm_0000000010'];
const PLANNER = 'tmm_0000000001';
const PM = 'tmm_0000000002';
const CHANNEL = 'ch_0000000001';
const FUTURE = '2026-09-16T00:40:00Z';
const PAST = '2026-09-15T23:00:00Z';

const setup = (timeoutAt: string = FUTURE) => {
  const seed = createLedger({
    round: 2,
    planVersion: { version: 'v0.3', lines: 233, hash: 'a1b2c3d4' },
    planPath: '.opencode/plans/alert-analyzer-fix-iteration-plan.md',
    taskId: 't_0000000001',
    issueId: 'is_0000000007',
    expected: MEMBERS,
    expectedRoles: ['架构视角', '开发视角', '测试视角'],
    timeoutAt,
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
  const notifier: ConvergenceNotifier & { calls: unknown[] } = {
    calls: [],
    dispatchAgentMention: jest.fn(async () => undefined),
  };
  const gate = new ReviewRoundGateService(
    readPrisma as never,
    rounds,
    notifier,
  );
  const notifyOpts = {
    channelId: CHANNEL,
    plannerMemberId: PLANNER,
    pmMemberId: PM,
    taskId: 't_0000000001',
  };
  return { gate, notifier, store, notifyOpts };
};

describe('ReviewRoundGateService（todo 7 收敛门）', () => {
  it('30 分钟超时时钟常量', () => {
    expect(REVIEW_ROUND_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it('2/3 修订请求被拒并提示 exact 待 N/N（m_446 类行为被拦）', async () => {
    const { gate, notifyOpts } = setup();
    await gate.recordVerdict(
      'is_0000000007',
      {
        member: MEMBERS[0],
        verdict: 'REJECT',
        msgId: 'm_446',
        version: 'v0.3',
      },
      notifyOpts,
    );
    await gate.recordVerdict(
      'is_0000000007',
      {
        member: MEMBERS[1],
        verdict: 'APPROVE',
        msgId: 'm_447',
        version: 'v0.3',
      },
      notifyOpts,
    );
    await expect(
      gate.requestRevision('is_0000000007', PLANNER),
    ).rejects.toThrow(/待 2\/3/);
  });

  it('缺版本打回： demanding version，本次永不计入 received', async () => {
    const { gate, notifyOpts } = setup();
    const r = await gate.recordVerdict(
      'is_0000000007',
      { member: MEMBERS[0], verdict: 'REJECT', msgId: 'm_x' },
      notifyOpts,
    );
    expect(r.outcome).toBe('missing-version');
    expect(r.hint).toMatch(/待 0\/3/);
    expect(r.hint).toMatch(/版本/);
    expect(r.ledger.received[MEMBERS[0]]).toBeUndefined();
    expect(r.converged).toBe(false);
  });

  it('跨版本 verdicts 分开：旧版标 superseded 归档，不触发修订', async () => {
    const { gate, notifier, notifyOpts } = setup();
    const r = await gate.recordVerdict(
      'is_0000000007',
      {
        member: MEMBERS[2],
        verdict: 'REJECT',
        msgId: 'm_510',
        version: 'v0.2',
      },
      notifyOpts,
    );
    expect(r.outcome).toBe('superseded');
    expect(r.ledger.received[MEMBERS[2]]).toBeUndefined();
    expect(r.ledger.superseded ?? []).toHaveLength(1);
    expect(r.converged).toBe(false);
    expect(notifier.dispatchAgentMention).not.toHaveBeenCalled();
    await expect(
      gate.requestRevision('is_0000000007', PLANNER),
    ).rejects.toThrow(/待 0\/3/);
  });

  it('同轮同人多次 verdicts 取最后一次', async () => {
    const { gate, notifyOpts } = setup();
    await gate.recordVerdict(
      'is_0000000007',
      { member: MEMBERS[0], verdict: 'REJECT', msgId: 'm_1', version: 'v0.3' },
      notifyOpts,
    );
    const r = await gate.recordVerdict(
      'is_0000000007',
      { member: MEMBERS[0], verdict: 'APPROVE', msgId: 'm_2', version: 'v0.3' },
      notifyOpts,
    );
    expect(r.outcome).toBe('received');
    expect(r.ledger.received[MEMBERS[0]]).toEqual({
      verdict: 'APPROVE',
      msgId: 'm_2',
      version: 'v0.3',
    });
  });

  it('3/3 自动通知计划员 + 抄 PM：kind=wake（无回执环、免 throttle）', async () => {
    const { gate, notifier, notifyOpts } = setup();
    for (const [i, m] of MEMBERS.entries()) {
      await gate.recordVerdict(
        'is_0000000007',
        { member: m, verdict: 'APPROVE', msgId: `m_54${i}`, version: 'v0.3' },
        notifyOpts,
      );
    }
    expect(notifier.dispatchAgentMention).toHaveBeenCalledTimes(2);
    const calls = (notifier.dispatchAgentMention as jest.Mock).mock.calls.map(
      (c) => c[0] as { targetInstanceId: string; kind: string; text: string },
    );
    expect(calls.map((c) => c.targetInstanceId).sort()).toEqual(
      [PLANNER, PM].sort(),
    );
    for (const c of calls) {
      expect(c.kind).toBe('wake');
      expect(c.text).toMatch(/R2/);
      expect(c.text).toMatch(/v0\.3/);
      expect(c.text).toMatch(/3\/3/);
    }
    const ok = await gate.requestRevision('is_0000000007', PLANNER);
    expect(ok.allowed).toBe(true);
  });

  it('3/3 收敛→计划置 pending_final（永不直接 approved；无 sink 时不抛）', async () => {
    const { gate, notifyOpts } = setup();
    const planSink = { transition: jest.fn(async () => ({})) };
    gate.attachPlanSink(planSink);
    for (const [i, m] of MEMBERS.entries()) {
      await gate.recordVerdict(
        'is_0000000007',
        { member: m, verdict: 'APPROVE', msgId: `m_55${i}`, version: 'v0.3' },
        notifyOpts,
      );
    }
    expect(planSink.transition).toHaveBeenCalledTimes(1);
    expect(planSink.transition).toHaveBeenCalledWith(
      't_0000000001',
      'pending_final',
    );
    for (const call of planSink.transition.mock.calls) {
      expect((call as unknown[])[1]).not.toBe('approved');
    }
  });

  it('3/3 收敛无 planSink→照常 complete+通知（计划翻转缺席永不阻断收敛）', async () => {
    const { gate, notifier, notifyOpts } = setup();
    for (const [i, m] of MEMBERS.entries()) {
      await gate.recordVerdict(
        'is_0000000007',
        { member: m, verdict: 'APPROVE', msgId: `m_56${i}`, version: 'v0.3' },
        notifyOpts,
      );
    }
    expect(notifier.dispatchAgentMention).toHaveBeenCalledTimes(2);
    const ok = await gate.requestRevision('is_0000000007', PLANNER);
    expect(ok.allowed).toBe(true);
  });

  it('3/3 含 REJECT → complete+通知照发，但计划回 draft（§6.1 REJECT 回流分支）', async () => {
    const { gate, notifier, notifyOpts } = setup();
    const planSink = { transition: jest.fn(async () => ({})) };
    gate.attachPlanSink(planSink);
    await gate.recordVerdict(
      'is_0000000007',
      {
        member: MEMBERS[0],
        verdict: 'APPROVE',
        msgId: 'm_571',
        version: 'v0.3',
      },
      notifyOpts,
    );
    await gate.recordVerdict(
      'is_0000000007',
      {
        member: MEMBERS[1],
        verdict: 'APPROVE',
        msgId: 'm_572',
        version: 'v0.3',
      },
      notifyOpts,
    );
    const last = await gate.recordVerdict(
      'is_0000000007',
      {
        member: MEMBERS[2],
        verdict: 'REJECT',
        msgId: 'm_573',
        version: 'v0.3',
      },
      notifyOpts,
    );
    expect(last.converged).toBe(true);
    expect(last.ledger.status).toBe('complete');
    expect(planSink.transition).toHaveBeenCalledTimes(1);
    expect(planSink.transition).toHaveBeenCalledWith('t_0000000001', 'draft');
    for (const call of planSink.transition.mock.calls) {
      expect((call as unknown[])[1]).not.toBe('pending_final');
      expect((call as unknown[])[1]).not.toBe('approved');
      expect((call as unknown[])[1]).not.toBe('executing');
    }
    expect(notifier.dispatchAgentMention).toHaveBeenCalledTimes(2);
    const texts = (notifier.dispatchAgentMention as jest.Mock).mock.calls.map(
      (c) => (c[0] as { text: string }).text,
    );
    expect(texts.join(' ')).toMatch(/REJECT/);
    const ok = await gate.requestRevision('is_0000000007', PLANNER);
    expect(ok.allowed).toBe(true);
  });

  it('全员 REJECT → sink 走 draft（pending_final 永不出现在被否决轮次）', async () => {
    const { gate, notifier, notifyOpts } = setup();
    const planSink = { transition: jest.fn(async () => ({})) };
    gate.attachPlanSink(planSink);
    for (const [i, m] of MEMBERS.entries()) {
      await gate.recordVerdict(
        'is_0000000007',
        { member: m, verdict: 'REJECT', msgId: `m_58${i}`, version: 'v0.3' },
        notifyOpts,
      );
    }
    expect(planSink.transition).toHaveBeenCalledTimes(1);
    expect(planSink.transition).toHaveBeenCalledWith('t_0000000001', 'draft');
    expect(notifier.dispatchAgentMention).toHaveBeenCalledTimes(2);
  });

  it('stale：超时转人工产出待拍板项，且绝不通知计划员', async () => {
    const { gate, notifier, notifyOpts } = setup(PAST);
    await gate.recordVerdict(
      'is_0000000007',
      { member: MEMBERS[0], verdict: 'APPROVE', msgId: 'm_1', version: 'v0.3' },
      notifyOpts,
    );
    await gate.recordVerdict(
      'is_0000000007',
      { member: MEMBERS[1], verdict: 'APPROVE', msgId: 'm_2', version: 'v0.3' },
      notifyOpts,
    );
    const stale = await gate.checkTimeout(
      'is_0000000007',
      new Date('2026-09-16T00:00:00Z'),
    );
    expect(stale.stale).toBe(true);
    expect(stale.ledger.status).toBe('stale');
    expect(stale.absentees).toEqual([MEMBERS[2]]);
    expect(stale.adjudications.map((a) => a.kind)).toEqual([
      'wait',
      'nudge',
      'degraded-release',
    ]);
    const nudge = stale.adjudications.find((a) => a.kind === 'nudge');
    expect(nudge?.absentees).toEqual([MEMBERS[2]]);
    const degraded = stale.adjudications.find(
      (a) => a.kind === 'degraded-release',
    );
    expect(degraded?.requiresConfirm).toBe(true);
    // 超时绝不自动通知计划员
    expect(notifier.dispatchAgentMention).not.toHaveBeenCalled();
  });

  it('N-1 降级放行必须显式确认：超时不自动放行，无确认不 complete', async () => {
    const { gate, notifier, notifyOpts } = setup(PAST);
    await gate.recordVerdict(
      'is_0000000007',
      { member: MEMBERS[0], verdict: 'APPROVE', msgId: 'm_1', version: 'v0.3' },
      notifyOpts,
    );
    await gate.recordVerdict(
      'is_0000000007',
      { member: MEMBERS[1], verdict: 'APPROVE', msgId: 'm_2', version: 'v0.3' },
      notifyOpts,
    );
    await gate.checkTimeout('is_0000000007', new Date('2026-09-16T00:00:00Z'));
    // 未确认前仍是 stale：修订仍被拒
    await expect(
      gate.requestRevision('is_0000000007', PLANNER),
    ).rejects.toThrow(/待 2\/3/);
    // 非 stale 轮次确认即抛错（防误调）
    const { gate: fresh } = setup(FUTURE);
    await expect(
      fresh.confirmDegradedRelease('is_0000000007', PM, {
        ...notifyOpts,
        waived: [MEMBERS[2]],
      }),
    ).rejects.toThrow(/stale/);
    // 显式确认后才放行
    const done = await gate.confirmDegradedRelease('is_0000000007', PM, {
      ...notifyOpts,
      waived: [MEMBERS[2]],
    });
    expect(done.ledger.status).toBe('complete');
    expect(done.waived).toEqual([MEMBERS[2]]);
    expect(notifier.dispatchAgentMention).toHaveBeenCalledTimes(2);
  });

  it('F2#2：第二次派发抛错 → recordVerdict 仍 resolve（complete 后通知尽力而为）', async () => {
    const { gate, notifier, notifyOpts } = setup();
    const warn = jest
      .spyOn(
        (gate as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation((() => undefined) as unknown as jest.Mock);
    (notifier.dispatchAgentMention as jest.Mock).mockImplementation(
      async (input: { targetInstanceId: string }) => {
        if (input.targetInstanceId === PM) throw new Error('dispatcher 瞬断');
      },
    );
    for (const [i, m] of MEMBERS.slice(0, 2).entries()) {
      await gate.recordVerdict(
        'is_0000000007',
        { member: m, verdict: 'APPROVE', msgId: `m_59${i}`, version: 'v0.3' },
        notifyOpts,
      );
    }
    const last = await gate.recordVerdict(
      'is_0000000007',
      {
        member: MEMBERS[2],
        verdict: 'APPROVE',
        msgId: 'm_592',
        version: 'v0.3',
      },
      notifyOpts,
    );
    expect(last.converged).toBe(true);
    expect(last.ledger.status).toBe('complete');
    expect(notifier.dispatchAgentMention).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('抄送PM失败'));
    // 后续重发走终态 early-return，同样 resolve（F2#5 联动：不再写库）
    await expect(
      gate.recordVerdict(
        'is_0000000007',
        {
          member: MEMBERS[0],
          verdict: 'APPROVE',
          msgId: 'm_594',
          version: 'v0.3',
        },
        notifyOpts,
      ),
    ).resolves.toMatchObject({ converged: true });
    warn.mockRestore();
  });

  it('F2#3：修订拒绝错误携带稳定 code（message 仍含 exact 待 N/M）', async () => {
    const { gate, notifyOpts } = setup();
    await gate.recordVerdict(
      'is_0000000007',
      {
        member: MEMBERS[0],
        verdict: 'REJECT',
        msgId: 'm_446',
        version: 'v0.3',
      },
      notifyOpts,
    );
    const err = await gate
      .requestRevision('is_0000000007', PLANNER)
      .catch((e: unknown) => e);
    expect((err as { code?: unknown }).code).toBe(
      REVIEW_ROUND_GATE_ERRORS.REVISION_REFUSED,
    );
    expect((err as Error).message).toMatch(/待 1\/3/);
  });

  it('F2#5：终态账本不再被后续 verdict 改写（received 保持原 msgId）', async () => {
    const { gate, notifyOpts } = setup();
    for (const [i, m] of MEMBERS.entries()) {
      await gate.recordVerdict(
        'is_0000000007',
        { member: m, verdict: 'APPROVE', msgId: `m_60${i}`, version: 'v0.3' },
        notifyOpts,
      );
    }
    // 同版本新 msgId 重发 → 不声称计入，received 原样保留
    const r = await gate.recordVerdict(
      'is_0000000007',
      {
        member: MEMBERS[0],
        verdict: 'APPROVE',
        msgId: 'm_999',
        version: 'v0.3',
      },
      notifyOpts,
    );
    expect(r.outcome).not.toBe('received');
    expect(r.ledger.received[MEMBERS[0]].msgId).toBe('m_600');
    expect(r.ledger.status).toBe('complete');
    // 同 msgId 幂等重发 → 无害（outcome received，但内容不变）
    const same = await gate.recordVerdict(
      'is_0000000007',
      {
        member: MEMBERS[0],
        verdict: 'APPROVE',
        msgId: 'm_600',
        version: 'v0.3',
      },
      notifyOpts,
    );
    expect(same.outcome).toBe('received');
    expect(same.ledger.received[MEMBERS[0]].msgId).toBe('m_600');
  });

  it('F2#5：stale 账本上的 verdict 不写 received 且 converged 为 false', async () => {
    const { gate, notifyOpts } = setup(PAST);
    await gate.recordVerdict(
      'is_0000000007',
      { member: MEMBERS[0], verdict: 'APPROVE', msgId: 'm_1', version: 'v0.3' },
      notifyOpts,
    );
    await gate.checkTimeout('is_0000000007', new Date('2026-09-16T00:00:00Z'));
    const r = await gate.recordVerdict(
      'is_0000000007',
      { member: MEMBERS[1], verdict: 'APPROVE', msgId: 'm_2', version: 'v0.3' },
      notifyOpts,
    );
    expect(r.ledger.status).toBe('stale');
    expect(r.ledger.received[MEMBERS[1]]).toBeUndefined();
    expect(r.outcome).not.toBe('received');
    expect(r.converged).toBe(false);
  });
});
