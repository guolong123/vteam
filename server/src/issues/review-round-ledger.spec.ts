import {
  REVIEW_ROUND_DELIMITER,
  REVIEW_ROUND_SCHEMA_VERSION,
  computePlanHash,
  createLedger,
  embedLedger,
  mergeLedger,
  parseLedger,
  resolveVerdict,
} from './review-round-ledger';

const BASE = () =>
  createLedger({
    round: 2,
    planVersion: { version: 'v0.3', lines: 233, hash: 'a1b2c3d4' },
    planPath: '.opencode/plans/alert-analyzer-fix-iteration-plan.md',
    taskId: 't_0000000001',
    issueId: 'is_0000000007',
    expected: ['tmm_0000000012', 'tmm_0000000009', 'tmm_0000000010'],
    expectedRoles: ['架构视角', '开发视角', '测试视角'],
    timeoutAt: '2026-09-16T00:40:00Z',
  });

describe('review-round-ledger', () => {
  describe('delimiter + schema', () => {
    it('分隔符逐字节精确', () => {
      expect(REVIEW_ROUND_DELIMITER).toBe('<!-- REVIEW-ROUND-JSON -->');
    });

    it('schemaVersion 恒为 1', () => {
      expect(REVIEW_ROUND_SCHEMA_VERSION).toBe(1);
      expect(BASE().schemaVersion).toBe(1);
    });

    it('账本读写往返（human 文本保留 + 机器段可解析）', () => {
      const text = embedLedger('请评审 v0.3（架构/开发/测试）', BASE());
      expect(text).toContain('请评审 v0.3');
      expect(text).toContain('<!-- REVIEW-ROUND-JSON -->');
      expect(text).toContain('```json');
      const back = parseLedger(text);
      expect(back).not.toBeNull();
      expect(back?.round).toBe(2);
      expect(back?.planVersion).toEqual({
        version: 'v0.3',
        lines: 233,
        hash: 'a1b2c3d4',
      });
      expect(back?.expected).toEqual([
        'tmm_0000000012',
        'tmm_0000000009',
        'tmm_0000000010',
      ]);
      expect(back?.status).toBe('collecting');
      expect(back?.timeoutAt).toBe('2026-09-16T00:40:00Z');
    });

    it('无机器段 → null（不抛错）', () => {
      expect(parseLedger(null)).toBeNull();
      expect(parseLedger('纯人类文本，无账本')).toBeNull();
    });

    it('重复 embed 只保留一份机器段（幂等替换）', () => {
      const once = embedLedger('标题', BASE());
      const twice = embedLedger(once, { ...BASE(), round: 3 });
      expect(twice.split(REVIEW_ROUND_DELIMITER).length - 1).toBe(1);
      expect(parseLedger(twice)?.round).toBe(3);
    });
  });

  describe('computePlanHash', () => {
    it('sha1 前 8（与 planner-revise 落盘钩口径一致）', () => {
      const { createHash } = jest.requireActual('crypto') as typeof import('crypto');
      const content = '# plan\n\n- step 1\n';
      expect(computePlanHash(content)).toBe(
        createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 8),
      );
      expect(computePlanHash(content)).toHaveLength(8);
    });
  });

  describe('mergeLedger（并发合并规则）', () => {
    it('received 按成员覆盖：双写不同成员互不丢失', () => {
      const a = mergeLedger(BASE(), {
        received: {
          member: 'tmm_0000000012',
          verdict: 'APPROVE',
          msgId: 'm_1',
          version: 'v0.3',
        },
      });
      const b = mergeLedger(a, {
        received: {
          member: 'tmm_0000000009',
          verdict: 'REJECT',
          msgId: 'm_2',
          version: 'v0.3',
        },
      });
      expect(Object.keys(b.received).sort()).toEqual([
        'tmm_0000000009',
        'tmm_0000000012',
      ]);
    });

    it('同一轮同一人多次回执取最后一次', () => {
      const a = mergeLedger(BASE(), {
        received: {
          member: 'tmm_0000000012',
          verdict: 'REJECT',
          msgId: 'm_1',
          version: 'v0.3',
        },
      });
      const b = mergeLedger(a, {
        received: {
          member: 'tmm_0000000012',
          verdict: 'APPROVE',
          msgId: 'm_2',
          version: 'v0.3',
        },
      });
      expect(b.received['tmm_0000000012']).toEqual({
        verdict: 'APPROVE',
        msgId: 'm_2',
        version: 'v0.3',
      });
    });

    it('round/version 只升不降', () => {
      const up = mergeLedger(BASE(), { round: 3 });
      expect(up.round).toBe(3);
      const down = mergeLedger(up, { round: 2 });
      expect(down.round).toBe(3);
      const verDown = mergeLedger(BASE(), {
        planVersion: { version: 'v0.2', lines: 100, hash: 'ffffffff' },
      });
      expect(verDown.planVersion.version).toBe('v0.3');
      const verUp = mergeLedger(BASE(), {
        planVersion: { version: 'v0.4', lines: 250, hash: 'eeeeeeee' },
      });
      expect(verUp.planVersion).toEqual({
        version: 'v0.4',
        lines: 250,
        hash: 'eeeeeeee',
      });
    });
  });

  describe('resolveVerdict', () => {
    it('hash 缺失 → pending-hash 挂起，绝不标 superseded', () => {
      const noHash = createLedger({
        round: 1,
        planVersion: { version: 'v0.1', lines: 10, hash: '' },
        expected: ['tmm_0000000012'],
        timeoutAt: '2026-09-16T00:40:00Z',
      });
      const r = resolveVerdict(noHash, {
        member: 'tmm_0000000012',
        verdict: 'APPROVE',
        msgId: 'm_9',
        version: 'v0.0-unknown',
      });
      expect(r.outcome).toBe('pending-hash');
      // 即使版本也对不上，仍挂起而非过期
      expect(r.ledger.received['tmm_0000000012']).toBeUndefined();
      expect(r.ledger.superseded ?? []).toHaveLength(0);
      expect(r.ledger.pending).toHaveLength(1);
      expect(r.ledger.pending?.[0]).toMatchObject({
        member: 'tmm_0000000012',
        reason: 'pending-hash',
      });
    });

    it('版本不符（有 hash）→ superseded 归档，不计入 received', () => {
      const r = resolveVerdict(BASE(), {
        member: 'tmm_0000000010',
        verdict: 'REJECT',
        msgId: 'm_510',
        version: 'v0.2',
      });
      expect(r.outcome).toBe('superseded');
      expect(r.ledger.received['tmm_0000000010']).toBeUndefined();
      expect(r.ledger.superseded?.[0]).toMatchObject({
        msgId: 'm_510',
        version: 'v0.2',
      });
    });

    it('版本相符 → received（覆盖旧值）', () => {
      const r = resolveVerdict(BASE(), {
        member: 'tmm_0000000010',
        verdict: 'APPROVE',
        msgId: 'm_540',
        version: 'v0.3',
      });
      expect(r.outcome).toBe('received');
      expect(r.ledger.received['tmm_0000000010']).toEqual({
        verdict: 'APPROVE',
        msgId: 'm_540',
        version: 'v0.3',
      });
    });
  });
});
