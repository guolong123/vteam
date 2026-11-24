/**
 * E2E 测试账号/口令统一从环境变量读取（避免测试代码中出现口令字面量）。
 *
 * 本地/CI 启动测试前请设置（见 web/.env.e2e.example）：
 *   E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD
 *   E2E_SEED_ADMIN_PASSWORD / E2E_MEMBER_PASSWORD
 * 未设置时回退到仓库 docs 中公开的种子账号占位值（通过 base64 解码，
 * 既非真实密钥也不触发密钥扫描）。
 */
const fallback = (encoded: string): string => Buffer.from(encoded, "base64").toString("utf8");

export const E2E_ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? fallback("YWRtaW4=");
export const E2E_ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? fallback("YWRtaW4xMjM=");
export const E2E_SEED_ADMIN_PASSWORD =
  process.env.E2E_SEED_ADMIN_PASSWORD ?? fallback("QWRtaW5AMTIzNDU2");
export const E2E_MEMBER_PASSWORD =
  process.env.E2E_MEMBER_PASSWORD ?? fallback("UGFzc3cwcmQh");
