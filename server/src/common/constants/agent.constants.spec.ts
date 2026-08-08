import {
  buildModelSeedRows,
  STATIC_AVAILABLE_MODELS,
  TEMPLATE_DEFAULT_MODELS,
} from './agent.constants';

describe('模型目录 seed 预置（C1：STATIC_AVAILABLE_MODELS → models 表）', () => {
  it('seed 行数与 STATIC_AVAILABLE_MODELS 一致（8 模型防空目录回归）', () => {
    const rows = buildModelSeedRows();
    expect(rows).toHaveLength(STATIC_AVAILABLE_MODELS.length);
    expect(rows).toHaveLength(8);
  });

  it('每行均 enabled=true + md_ 零填充序号（唯一 id）', () => {
    const rows = buildModelSeedRows();
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length);
    for (const row of rows) {
      expect(row.id).toMatch(/^md_\d{10}$/);
      expect(row.enabled).toBe(true);
    }
  });

  it('id 拆解：含 / 按首段拆 providerID/modelID；不含视为 opencode 默认 provider', () => {
    const rows = buildModelSeedRows();
    const flash = rows.find((r) => r.modelID === 'deepseek-v4-flash');
    expect(flash).toMatchObject({ providerID: 'opencode-go', modelID: 'deepseek-v4-flash' });
    const pro = rows.find((r) => r.modelID === 'deepseek-v4-pro');
    expect(pro).toMatchObject({ providerID: 'opencode', modelID: 'deepseek-v4-pro' });
  });

  it('四类模板默认模型均指向目录中存在的模型（providerID/modelID 格式）', () => {
    const rows = buildModelSeedRows();
    const keys = new Set(rows.map((r) => `${r.providerID}/${r.modelID}`));
    expect(Object.keys(TEMPLATE_DEFAULT_MODELS).sort()).toEqual(
      ['a_architect', 'a_developer', 'a_product', 'a_tester'].sort(),
    );
    for (const modelId of Object.values(TEMPLATE_DEFAULT_MODELS)) {
      expect(keys.has(modelId)).toBe(true);
    }
  });
});
