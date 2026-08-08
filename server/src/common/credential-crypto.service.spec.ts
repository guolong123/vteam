import { CredentialCryptoService } from './credential-crypto.service';

describe('CredentialCryptoService（AES-256-GCM 加密存储）', () => {
  const HEX_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const OTHER_HEX_KEY =
    'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  const BASE64_KEY = Buffer.from('k'.repeat(32), 'utf8').toString('base64');
  const UTF8_KEY = 'u'.repeat(32); // 32 字节 utf8

  const makeService = (key: string | null | undefined, env = 'test') => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = env;
    try {
      const config = { get: jest.fn().mockReturnValue(key) };
      return new CredentialCryptoService(config as never);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalEnv;
      }
    }
  };

  describe('encrypt/decrypt（AES-256-GCM roundtrip）', () => {
    it('加密→解密还原明文（含特殊字符与长 token）', () => {
      const svc = makeService(HEX_KEY);
      const tokens = [
        'sk-abcdef1234567890',
        'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
        'Bearer  token-with  spaces 和中文',
        'a', // 极短 token
      ];
      for (const token of tokens) {
        const cipher = svc.encrypt(token);
        expect(svc.decrypt(cipher)).toBe(token);
      }
    });

    it('空明文拒绝加密（抛错）', () => {
      const svc = makeService(HEX_KEY);
      expect(() => svc.encrypt('')).toThrow();
    });

    it('三次加密同一明文产生不同密文（随机 iv）', () => {
      const svc = makeService(HEX_KEY);
      const c1 = svc.encrypt('sk-fixed-token');
      const c2 = svc.encrypt('sk-fixed-token');
      const c3 = svc.encrypt('sk-fixed-token');
      expect(new Set([c1, c2, c3]).size).toBe(3);
    });

    it('支持 base64 / utf8 编码的 32 字节 key', () => {
      const b64 = makeService(BASE64_KEY);
      const u8 = makeService(UTF8_KEY);
      const cipher = b64.encrypt('sk-base64-key-test');
      expect(b64.decrypt(cipher)).toBe('sk-base64-key-test');
      const cipher2 = u8.encrypt('sk-utf8-key-test');
      expect(u8.decrypt(cipher2)).toBe('sk-utf8-key-test');
    });

    it('错误 key 解密失败（authTag 校验抛错，不返回明文）', () => {
      const svc = makeService(HEX_KEY);
      const cipher = svc.encrypt('sk-secret-token');
      const wrong = makeService(OTHER_HEX_KEY);
      expect(() => wrong.decrypt(cipher)).toThrow();
    });

    it('密文被篡改解密失败（完整性保护）', () => {
      const svc = makeService(HEX_KEY);
      const cipher = svc.encrypt('sk-secret-token');
      // 篡改密文段最后一个 hex 字符
      const parts = cipher.split(':');
      const data = Buffer.from(parts[2], 'hex');
      data[0] = data[0] ^ 0xff;
      parts[2] = data.toString('hex');
      expect(() => svc.decrypt(parts.join(':'))).toThrow();
    });

    it('非法密文格式（段数不对）→ 抛错', () => {
      const svc = makeService(HEX_KEY);
      expect(() => svc.decrypt('abc')).toThrow();
      expect(() => svc.decrypt('a:b:')).toThrow();
    });
  });

  describe('密钥解析与缺失策略', () => {
    it('生产环境缺失 key → 启动抛错（拒绝静默弱 key）', () => {
      expect(() => makeService(undefined, 'production')).toThrow(
        'MODEL_CREDENTIAL_KEY 缺失',
      );
      expect(() => makeService('', 'production')).toThrow();
    });

    it('开发/测试缺失 key → 用显式标记的开发密钥（logger.warn），仍可加解密', () => {
      const svc = makeService(undefined, 'development');
      const cipher = svc.encrypt('sk-dev-key-test');
      expect(svc.decrypt(cipher)).toBe('sk-dev-key-test');
    });

    it('非法 key 长度/编码 → 抛错', () => {
      expect(() => makeService('short-key')).toThrow(
        'MODEL_CREDENTIAL_KEY 必须为 32 字节',
      );
      expect(() => makeService('zz'.repeat(32))).toThrow();
    });
  });

  describe('fingerprint（脱敏标识）', () => {
    it('常规 token：前 4 + **** + 后 4', () => {
      const svc = makeService(HEX_KEY);
      expect(svc.fingerprint('sk-abcdef1234567890')).toBe('sk-a****7890');
      expect(svc.fingerprint('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe(
        'ghp_****WXYZ',
      );
    });

    it('短 token（≤8）折半掩码兜底', () => {
      const svc = makeService(HEX_KEY);
      expect(svc.fingerprint('abcd1234')).toBe('ab****34');
      expect(svc.fingerprint('abc')).toBe('ab****bc');
    });

    it('空串返回空串', () => {
      const svc = makeService(HEX_KEY);
      expect(svc.fingerprint('')).toBe('');
    });

    it('fingerprint 不包含完整明文片段之外的还原能力（前后各 4 字符）', () => {
      const svc = makeService(HEX_KEY);
      const fp = svc.fingerprint('sk-super-secret-token-value');
      expect(fp).toMatch(/^sk-s\*\*\*\*alue$/);
      // 明文完整值不可从 fingerprint 还原
      expect(fp.includes('super')).toBe(false);
    });
  });
});
