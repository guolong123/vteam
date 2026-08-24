import { validatePlanTaskQuality } from './plan-quality.guard';

describe('validatePlanTaskQuality', () => {
  const base = {
    title: '实现登录接口',
    what: '新增 POST /api/login 接口',
    references: 'server/src/auth/auth.controller.ts',
    acceptance: '访问 /login 提交错误密码返回 401 且提示文案包含密码错误',
    qa: 'curl POST /api/v1/login 缺少 name 字段，断言返回 400',
  };

  it('happy: 含工具词与路径的 qa 与可判定 acceptance 放行', () => {
    const r = validatePlanTaskQuality(base);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('qa 纯空话测试一下被拒且 message 含改法', () => {
    const r = validatePlanTaskQuality({ ...base, qa: '测试一下' });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join('')).toMatch(/纯空话/);
    expect(r.errors.join('')).toMatch(/工具/);
  });

  it('qa 未含工具词与结构特征被拒', () => {
    const r = validatePlanTaskQuality({ ...base, qa: '验证功能正常可用' });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatch(/未包含/);
  });

  it('qa <8 字符被拒', () => {
    const r = validatePlanTaskQuality({ ...base, qa: 'curl' });
    expect(r.errors.some((e) => e.includes('过短'))).toBe(true);
  });

  it('acceptance 过短被拒', () => {
    const r = validatePlanTaskQuality({ ...base, acceptance: '可用' });
    expect(r.errors.some((e) => e.includes('acceptance'))).toBe(true);
  });

  it('acceptance 纯结论词被拒', () => {
    const r = validatePlanTaskQuality({ ...base, acceptance: '正常可用完成' });
    expect(r.errors.some((e) => e.includes('纯结论词'))).toBe(true);
  });

  it('references 无路径形状仅警告不阻断', () => {
    const r = validatePlanTaskQuality({ ...base, references: '需求文档第3节' });
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/references/);
  });

  it('references 含路径不警告', () => {
    const r = validatePlanTaskQuality({ ...base, references: './src/foo.ts' });
    expect(r.warnings).toEqual([]);
  });
});
