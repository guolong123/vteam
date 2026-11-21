/**
 * 渠道/通知配置的密钥脱敏（对外响应唯一口径）。
 *
 * 为什么抽出来：`maskSecrets` + `maskChannel` 曾在 5 个 controller 里逐字复制
 * （message-channels / notification-channels / task-channel-bindings /
 * team-channel-bindings / member-channel-bindings），任一处改了掩码口径就会出现
 * 「同一张表在不同端点泄漏程度不同」——这是安全敏感的重复，绝不能各写一份。
 *
 * 口径：
 * - `secrets` 非对象/数组/null → `{}`（不把原始值透出去）；
 * - 对象 → 键保留、值一律 `'***'`（前端要看到「配了哪些键」，但看不到内容）。
 */

/** 脱敏后的密钥表：键名保留（前端据此渲染「已配置」），值恒为掩码。 */
export type MaskedSecrets = Record<string, string>;

/** 唯一的掩码占位符（前端用同值判断「已配置/未修改」）。 */
export const SECRET_MASK = '***';

/**
 * 把密钥表脱敏为「键 → 掩码」。
 *
 * @param secrets - 数据库中的 `secrets` JSON 列（形状不可信）
 */
export function maskSecrets(
  secrets: Record<string, unknown> | null | undefined,
): MaskedSecrets {
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
    return {};
  }
  return Object.keys(secrets).reduce<MaskedSecrets>(
    (acc, k) => ({ ...acc, [k]: SECRET_MASK }),
    {},
  );
}

/**
 * 对整行做脱敏（把 `secrets` 列替换为掩码，其余字段原样透传）。
 *
 * 泛型保留入参形状，调用方仍能拿到自己的字段类型（此前各处签名为 `any`，
 * 导致响应字段拼错也不会报错）。
 *
 * @param row - 含 `secrets` 列的渠道/通知行
 */
export function maskChannel<T>(
  row: T,
): Omit<T, 'secrets'> & { secrets: MaskedSecrets } {
  // 单处收窄（入参形状不可信），对外保持调用方的行类型。
  const source = row as { secrets?: unknown };
  return {
    ...(row as object),
    secrets: maskSecrets(source.secrets as Record<string, unknown> | null),
  } as Omit<T, 'secrets'> & { secrets: MaskedSecrets };
}
