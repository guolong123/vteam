import {
  REVIEW_TRIPLET_HINT,
  ROLE_VIEW_FOOTER,
  ensureRoleViewFooter,
  parseReviewTriplet,
} from './review-dispatch-triplet';

/**
 * plan-review-execution-gates Todo 8（failing-first）：
 * PM 评审派发三元组 round + planVersion(+hash) + expected 名单；
 * 缺三元组 → 计划员侧拒绝并返回逐字 hint，修订不开始；
 * 视角边界（架构/开发/测试）写入派发词。
 * （本仓库 strictNullChecks 关闭：结果取可选字段直断言，不用判别联合收窄。）
 */
describe('评审派发三元组模板（todo8）', () => {
  const COMPLETE =
    '请评审本轮计划 R2 · 计划 v0.3#abcd1234 · expected: tmm_arch,tmm_dev,tmm_test，请各位于视角边界内发表 VERDICT';

  it('三元组齐全 → 解析出 round/planVersion/planHash/expected', () => {
    const result = parseReviewTriplet(COMPLETE);

    expect(result.ok).toBe(true);
    expect(result.triplet?.round).toBe(2);
    expect(result.triplet?.planVersion).toBe('v0.3');
    expect(result.triplet?.planHash).toBe('abcd1234');
    expect(result.triplet?.expected).toEqual([
      'tmm_arch',
      'tmm_dev',
      'tmm_test',
    ]);
  });

  it('缺 round → 拒绝并列出缺失项', () => {
    const result = parseReviewTriplet(
      '请评审计划 v0.3#abcd1234 · expected: tmm_arch,tmm_dev',
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toContain('round');
    expect(result.missing).not.toContain('planVersion');
  });

  it('缺版本号 → 拒绝并列出缺失项', () => {
    const result = parseReviewTriplet(
      '请评审本轮计划 R2 · expected: tmm_arch,tmm_dev',
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toContain('planVersion');
  });

  it('缺 hash → 拒绝并列出缺失项（planVersion 必须带 hash 钉定）', () => {
    const result = parseReviewTriplet(
      '请评审本轮计划 R2 · 计划 v0.3 · expected: tmm_arch,tmm_dev',
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toContain('planHash');
    expect(result.missing).not.toContain('planVersion');
  });

  it('缺 expected 名单 → 拒绝并列出缺失项', () => {
    const result = parseReviewTriplet(
      '请评审本轮计划 R2 · 计划 v0.3#abcd1234，请发表意见',
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toContain('expected');
  });

  it('expected 无 tmm_ 成员 → 视为缺 expected', () => {
    const result = parseReviewTriplet(
      '请评审 R2 · v0.3#abcd1234 · expected: 架构同学',
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toContain('expected');
  });

  it('空内容 → 四项全缺', () => {
    const result = parseReviewTriplet('');

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining(['round', 'planVersion', 'planHash', 'expected']),
    );
  });

  it('精确 hint 逐字锁定（计划员侧退回话术，改一字即红）', () => {
    expect(REVIEW_TRIPLET_HINT).toBe(
      '评审派发缺三元组：须携带 round + planVersion(+hash) + expected 名单（例：R2 · v0.3#abcd1234 · expected: tmm_aaa,tmm_bbb）；本次派发已拒绝触发，修订不得开始，补齐三元组后重派',
    );
  });

  it('视角边界 footer 写死三角色分工（docs 33 §3.5）', () => {
    expect(ROLE_VIEW_FOOTER).toMatch('架构=方案/边界/状态机');
    expect(ROLE_VIEW_FOOTER).toMatch('开发=可执行性/依赖/工作量');
    expect(ROLE_VIEW_FOOTER).toMatch('测试=覆盖/判据可执行性');
  });

  it('派发词缺视角边界 → 追加 footer', () => {
    const out = ensureRoleViewFooter(COMPLETE);

    expect(out).toContain(COMPLETE);
    expect(out).toContain(ROLE_VIEW_FOOTER);
  });

  it('派发词已有视角边界 → 幂等不重复追加', () => {
    const once = ensureRoleViewFooter(COMPLETE);
    const twice = ensureRoleViewFooter(once);

    expect(twice).toBe(once);
  });
});
