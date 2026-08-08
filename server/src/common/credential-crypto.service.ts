import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * 模型凭据加密服务（C4，17 篇 §3.4 安全基线）。
 *
 * AES-256-GCM 加解密：
 * - 密钥来自环境变量 `MODEL_CREDENTIAL_KEY`（32 字节，支持 64 位 hex / base64 / utf8 三种编码）；
 * - 密文格式 `ivHex:authTagHex:ciphertextHex`（GCM 附带认证标签，防篡改）；
 * - 解密时 authTag 校验失败（密钥错误/密文被篡改）→ 抛错（不返回任何明文）。
 *
 * 缺失密钥策略（显式标记，绝不静默弱 key）：
 * - NODE_ENV=production 且无 key → 启动抛错（拒绝用不可信密钥加密真实凭据）；
 * - 其他环境（development/test）→ 使用硬编码 `DEV_MODEL_CREDENTIAL_KEY` 并打
 *   `logger.warn` 显式标记「开发密钥」，保证测试/本地可用且可追溯。
 *
 * 脱敏 fingerprint：token 前 4 + `****` + 后 4（如 `sk-a****89xz`），短 token 折半掩码；
 * 明文 token 绝不进入日志/审计事件/响应，仅以 fingerprint 出现。
 */
@Injectable()
export class CredentialCryptoService {
  private readonly logger = new Logger(CredentialCryptoService.name);

  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 12; // GCM 推荐 96-bit
  /** 仅非生产环境使用的显式开发密钥（64 hex = 32 字节）。 */
  private static readonly DEV_MODEL_CREDENTIAL_KEY =
    '0000000000000000000000000000000000000000000000000000000000000000';

  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('MODEL_CREDENTIAL_KEY');
    const env = process.env.NODE_ENV ?? 'development';
    if (raw && raw.trim().length > 0) {
      this.key = this.parseKey(raw.trim());
      return;
    }
    if (env === 'production') {
      throw new Error(
        'MODEL_CREDENTIAL_KEY 缺失：生产环境必须配置 32 字节 AES-256-GCM 密钥，拒绝使用开发密钥加密凭据',
      );
    }
    // 开发/测试环境：显式标记的开发密钥（日志警告，可追溯）
    this.key = this.parseKey(CredentialCryptoService.DEV_MODEL_CREDENTIAL_KEY);
    this.logger.warn(
      'MODEL_CREDENTIAL_KEY 未配置，使用【显式标记的开发密钥】加密模型凭据（仅限开发/测试，生产环境禁止）',
    );
  }

  /** 解析 32 字节密钥：优先 64 位 hex → base64 → utf8（均须恰好 32 字节）。 */
  private parseKey(raw: string): Buffer {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    const b64 = Buffer.from(raw, 'base64');
    if (b64.length === 32) {
      return b64;
    }
    const utf8 = Buffer.from(raw, 'utf8');
    if (utf8.length === 32) {
      return utf8;
    }
    throw new Error(
      'MODEL_CREDENTIAL_KEY 必须为 32 字节密钥（64 位 hex / base64 / 32 字节 utf8）',
    );
  }

  /**
   * AES-256-GCM 加密。返回 `ivHex:authTagHex:ciphertextHex` 三段式密文，
   * 可直接落库 credentialRef 列。
   */
  encrypt(plaintext: string): string {
    if (!plaintext) {
      throw new Error('待加密明文不能为空');
    }
    const iv = randomBytes(CredentialCryptoService.IV_LENGTH);
    const cipher = createCipheriv(
      CredentialCryptoService.ALGORITHM,
      this.key,
      iv,
    );
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * AES-256-GCM 解密。密钥错误或密文被篡改时 authTag 校验失败 → 抛错。
   * 返回原始明文（调用方不得将明文写入日志/响应，C5 下发时使用）。
   */
  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      throw new Error('凭据密文格式非法（应为 iv:authTag:ciphertext 三段）');
    }
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = createDecipheriv(
      CredentialCryptoService.ALGORITHM,
      this.key,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /**
   * token 脱敏指纹：前 4 + `****` + 后 4（如 `sk-a****89xz`）。
   * 短 token（≤8）折半掩码兜底；空串返回空串。
   */
  fingerprint(token: string): string {
    if (!token) return '';
    if (token.length <= 8) {
      const head = token.slice(0, 2);
      const tail = token.slice(-2);
      return `${head}****${tail}`;
    }
    return `${token.slice(0, 4)}****${token.slice(-4)}`;
  }
}
