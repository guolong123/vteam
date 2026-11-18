/**
 * models.dev 能力映射与同步的单元测试（2026-11-18）。
 *
 * 核心要守住的语义：
 * 1. **逐模型**取能力，绝不按 provider 拉平
 *    （线上 commandcode 93 个模型里 73 个支持 image、20 个不支持，
 *      `deepseek-v4.1-flash` 支持而 `deepseek-v4-pro` 不支持）；
 * 2. 目录里没有的模型不动（不猜、不清空）；
 * 3. 管理员已显式配置的 capabilities 默认不覆盖；
 * 4. 目录拉取失败 → 一行都不写（能力同步是增强，不能影响平台功能）。
 */
import {
  mapModelsDevEntry,
  extractProviderCapabilities,
} from './models-dev-sync';

describe('models-dev-sync · mapModelsDevEntry', () => {
  it('完整条目 → 映射 modalities/toolCall/attachment/reasoning/limit', () => {
    expect(
      mapModelsDevEntry({
        attachment: true,
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1048576, output: 131072 },
      }),
    ).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      toolCall: true,
      attachment: true,
      reasoning: true,
      limit: { context: 1048576, output: 131072 },
    });
  });

  it('纯文本模型 → 不出现 image（明确不支持，不能补成支持）', () => {
    const caps = mapModelsDevEntry({
      attachment: false,
      tool_call: true,
      modalities: { input: ['text'], output: ['text'] },
    });
    expect(caps?.modalities?.input).toEqual(['text']);
    expect(caps?.modalities?.input).not.toContain('image');
    expect(caps?.attachment).toBe(false);
  });

  it('过滤未知模态 + 去重（models.dev 会持续加新模态，不能污染配置）', () => {
    const caps = mapModelsDevEntry({
      modalities: {
        input: ['text', 'image', 'hologram', 'image', ' text '],
        output: ['text'],
      },
    });
    expect(caps?.modalities?.input).toEqual(['text', 'image']);
  });

  it('limit 只给一半时保留一半（不因缺 output 而整体丢弃）', () => {
    expect(mapModelsDevEntry({ limit: { context: 200000 } })?.limit).toEqual({
      context: 200000,
    });
  });

  it('空条目 / 无任何能力字段 → undefined（调用方据此跳过，不覆盖库内值）', () => {
    expect(mapModelsDevEntry(undefined)).toBeUndefined();
    expect(mapModelsDevEntry({})).toBeUndefined();
    expect(mapModelsDevEntry({ id: 'x', name: 'y' })).toBeUndefined();
  });
});

describe('models-dev-sync · extractProviderCapabilities', () => {
  const catalog = {
    commandcode: {
      id: 'commandcode',
      api: 'https://api.commandcode.ai/provider/v1',
      models: {
        'deepseek/deepseek-v4.1-flash': {
          attachment: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
        'deepseek/deepseek-v4-pro': {
          attachment: false,
          modalities: { input: ['text'], output: ['text'] },
        },
        'z-ai/glm-5.3-flash': {
          attachment: true,
          modalities: {
            input: ['text', 'image', 'video', 'pdf'],
            output: ['text'],
          },
        },
      },
    },
  };

  it('同 provider 内逐模型能力**各不相同**（这正是不能拉平的证据）', () => {
    const caps = extractProviderCapabilities(catalog, 'commandcode');
    expect(caps.get('deepseek/deepseek-v4.1-flash')?.modalities?.input).toEqual(
      ['text', 'image'],
    );
    expect(caps.get('deepseek/deepseek-v4-pro')?.modalities?.input).toEqual([
      'text',
    ]);
    expect(caps.get('z-ai/glm-5.3-flash')?.modalities?.input).toEqual([
      'text',
      'image',
      'video',
      'pdf',
    ]);
  });

  it('providerID 未命中 → 按 baseUrl 与 models.dev 的 api 端点匹配（网关别名场景）', () => {
    const caps = extractProviderCapabilities(
      catalog,
      'my-gateway-alias',
      'https://api.commandcode.ai/provider/v1/',
    );
    expect(caps.size).toBe(3);
  });

  it('providerID 与 baseUrl 都匹配不到 → 空 Map（调用方跳过，不写任何行）', () => {
    expect(
      extractProviderCapabilities(catalog, 'unknown', 'https://x/v1').size,
    ).toBe(0);
  });
});
