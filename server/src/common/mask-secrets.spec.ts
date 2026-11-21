import { SECRET_MASK, maskChannel, maskSecrets } from './mask-secrets';

describe('common/mask-secrets（渠道密钥脱敏唯一口径）', () => {
  describe('maskSecrets', () => {
    it('键保留、值一律掩码', () => {
      expect(maskSecrets({ botId: 'real-id', secret: 'top-secret' })).toEqual({
        botId: SECRET_MASK,
        secret: SECRET_MASK,
      });
    });

    it('不泄漏任何原始值', () => {
      const out = maskSecrets({ token: 'super-secret-value' });
      expect(JSON.stringify(out)).not.toContain('super-secret-value');
    });

    it('null/undefined → 空对象', () => {
      expect(maskSecrets(null)).toEqual({});
      expect(maskSecrets(undefined)).toEqual({});
    });

    it('非对象/数组 → 空对象（不把原始值透出去）', () => {
      expect(
        maskSecrets('raw-string' as unknown as Record<string, unknown>),
      ).toEqual({});
      expect(
        maskSecrets(['a', 'b'] as unknown as Record<string, unknown>),
      ).toEqual({});
      expect(maskSecrets(42 as unknown as Record<string, unknown>)).toEqual({});
    });

    it('空对象 → 空对象', () => {
      expect(maskSecrets({})).toEqual({});
    });
  });

  describe('maskChannel', () => {
    it('保留其余字段、只替换 secrets', () => {
      const row = { id: 'c_1', type: 'wecom_aibot', secrets: { botId: 'x' } };
      expect(maskChannel(row)).toEqual({
        id: 'c_1',
        type: 'wecom_aibot',
        secrets: { botId: SECRET_MASK },
      });
    });

    it('secrets 缺失/null 时给出空对象（响应形状稳定）', () => {
      expect(maskChannel({ id: 'c_2' })).toEqual({ id: 'c_2', secrets: {} });
      expect(maskChannel({ id: 'c_3', secrets: null })).toEqual({
        id: 'c_3',
        secrets: {},
      });
    });

    it('不改写入参（纯函数）', () => {
      const row = { id: 'c_4', secrets: { k: 'v' } };
      maskChannel(row);
      expect(row.secrets).toEqual({ k: 'v' });
    });
  });
});
