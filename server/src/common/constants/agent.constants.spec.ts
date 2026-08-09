import {
  buildModelSeedRows,
  STATIC_AVAILABLE_MODELS,
  TEMPLATE_DEFAULT_MODELS,
} from './agent.constants';

describe('模型目录 seed 预置（C1：STATIC_AVAILABLE_MODELS → models 表）', () => {
  it('seed 行数与 STATIC_AVAILABLE_MODELS 一致（8 核心 + 26 worker 实测 opencode 免费 = 34 模型防空目录回归）', () => {
    const rows = buildModelSeedRows();
    expect(rows).toHaveLength(STATIC_AVAILABLE_MODELS.length);
    expect(rows).toHaveLength(34);
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

  it('id 拆解：全部 seed 模型携带真实 provider 前缀（D5 规范化）', () => {
    const rows = buildModelSeedRows();
    const flash = rows.find((r) => r.modelID === 'deepseek-v4-flash');
    expect(flash).toMatchObject({ providerID: 'opencode-go', modelID: 'deepseek-v4-flash' });
    const pro = rows.find((r) => r.modelID === 'deepseek-v4-pro');
    expect(pro).toMatchObject({ providerID: 'deepseek', modelID: 'deepseek-v4-pro' });
  });

  it('D5：seed 模型覆盖 ≥4 个不同 provider（Provider 页不再只有 opencode/opencode-go）', () => {
    const rows = buildModelSeedRows();
    const providers = new Set(rows.map((r) => r.providerID));
    expect(providers.size).toBeGreaterThanOrEqual(4);
    expect(providers.has('deepseek')).toBe(true);
    expect(providers.has('zhipu')).toBe(true);
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

  it('CONF-01：模板默认模型均为 worker 实际可执行的 opencode/* 免费模型（w_compose_worker 实测上报清单）', () => {
    // w_compose_worker capabilities.models 实测上报（B2/DB worker_model_availabilities 26 行）
    const workerCapableModels = new Set([
      'opencode/ling-3.0-tiny-free',
      'opencode/deepseek-v4-flash-free',
      'opencode/ling-3.0-flash-free',
      'opencode/laguna-s-2.1-free',
      'opencode/longcat-2.0-free',
      'opencode/hy3-free',
      'opencode/north-mini-code-free',
      'opencode/nemotron-3-ultra-free',
      'opencode/minimax-m3-free',
      'opencode/ring-2.6-1t-free',
      'opencode/mimo-v2.5-free',
      'opencode/ling-2.6-flash-free',
      'opencode/hy3-preview-free',
      'opencode/qwen3.6-plus-free',
      'opencode/mimo-v2-omni-free',
      'opencode/mimo-v2-pro-free',
      'opencode/nemotron-3-super-free',
      'opencode/minimax-m2.5-free',
      'opencode/glm-5-free',
      'opencode/trinity-large-preview-free',
      'opencode/kimi-k2.5-free',
      'opencode/minimax-m2.1-free',
      'opencode/glm-4.7-free',
      'opencode/mimo-v2-flash-free',
      'opencode/big-pickle',
      'opencode/grok-code',
    ]);
    expect(workerCapableModels.size).toBe(26);
    // STATIC_AVAILABLE_MODELS 中 opencode/* 免费模型应与 worker 清单一致（目录=能力，防空缺）
    const staticOpencodeIds = STATIC_AVAILABLE_MODELS.filter((m) =>
      m.id.startsWith('opencode/'),
    ).map((m) => m.id);
    expect(staticOpencodeIds.length).toBe(26);
    for (const id of staticOpencodeIds) {
      expect(workerCapableModels.has(id)).toBe(true);
    }
    for (const modelId of Object.values(TEMPLATE_DEFAULT_MODELS)) {
      expect(workerCapableModels.has(modelId)).toBe(true);
    }
  });
});
