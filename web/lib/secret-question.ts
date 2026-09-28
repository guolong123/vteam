/**
 * secret-question：`secret_input` 敏感输入弹窗的纯逻辑（sensitive-command-tool · todo 7）
 * =============================================
 * 唯一数据源是 server `questions.service.createSecretForPlatform()` 持久化的 content：
 *
 *   { source:'secret_input',
 *     template:string,
 *     variables:[{ name:string, secret:boolean }],
 *     reason:string|null }
 *
 * 该 content **只有模板与变量元数据**（secret 值从不落库、不回显、不进 SSE）；值由浏览器
 * 经 POST /questions/:id/reply 的 `{secrets}` 直接提交。因此本模块只做两件事：
 *   1. 把可能畸形的 content 归一成可渲染的字段清单（不抛错、不多造字段）；
 *   2. 组装提交体 —— 确认 `{secrets:{...}}`、取消/关闭/Esc/遮罩 `{secrets:null}`。
 *
 * 容错契约（malformed_input，与 server `secretVariableNamesOf` 同口径）：
 *   - content / variables 缺失或非数组 → 空清单（弹窗仍展示模板，确认提交 `{secrets:{}}`）；
 *   - 条目非对象、name 非字符串或空白 → 丢弃（留着会变成 server 不认的 key → 400「未声明变量」）；
 *   - 重名 → 保留首条（避免重复输入框与重复 payload key）；
 *   - `secret` 非布尔（缺省/坏值）→ 按敏感处理（mask 优先，宁可多遮不漏遮）。
 *
 * 必填契约：server 对**每个已声明变量**要求 `secrets[name]` 存在且为 string（缺值 400），
 * 故已声明变量全部必填；判定只用于门控，提交值保持用户原样（不 trim）。
 */

/** content.variables 元数据条目（server 只落 name/secret 两个字段）。 */
export interface SecretVariableField {
  name: string;
  /** 是否按敏感处理：true → password 输入框（`autoComplete="new-password"`）。 */
  secret: boolean;
}

/** 组装结果：确认 = {secrets:{变量:值}}；取消 = {secrets:null}（server 语义固定为 cancelled）。 */
export interface SecretReplyPayload {
  secrets: Record<string, string> | null;
}

/** 安全判型：普通对象（排除数组 / null）。 */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 变量清单（渲染顺序 = content.variables 声明顺序）。
 * 畸形元数据一律丢条目，不抛错 —— 弹窗不能因为模型给的元数据坏掉就白屏。
 */
export function secretVariablesOf(content: unknown): SecretVariableField[] {
  if (!isRecord(content)) return [];
  const raw = content.variables;
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const fields: SecretVariableField[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = item.name;
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    // secret 缺省或非布尔 → 按敏感处理（默认遮蔽）。
    fields.push({ name: trimmed, secret: typeof item.secret === "boolean" ? item.secret : true });
  }
  return fields;
}

/** 只读命令模板（非字符串/缺失 → 空串，渲染空的只读框而不是 crash）。 */
export function secretTemplateOf(content: unknown): string {
  if (!isRecord(content)) return "";
  return typeof content.template === "string" ? content.template : "";
}

/** 申请原因（空串/null/非字符串 → null，UI 不渲染该行）。 */
export function secretReasonOf(content: unknown): string | null {
  if (!isRecord(content)) return null;
  const reason = content.reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}

/**
 * 必填门控：每个已声明变量都要有非空白值（空白值对命令等价于没填）。
 * 无变量元数据（畸形/空）时返回 true —— 此时提交 `{secrets:{}}` 对 server 合法。
 */
export function canSubmitSecret(
  fields: SecretVariableField[],
  values: Record<string, string>,
): boolean {
  return fields.every((field) => (values[field.name] ?? "").trim().length > 0);
}

/**
 * 组装提交体（确认与取消共用一个入口，杜绝「取消带值 / 确认带 null」的错接）：
 * - `cancel` → `{secrets:null}`，**即使 values 里已有值也绝不带上**；
 * - `submit` → 只含已声明变量名 → 用户原样值（不 trim、不改写），丢弃任何未声明 key
 *   （server 会以 400「secrets 含未声明变量」拒绝，前端先裁剪掉）。
 */
export function buildSecretReply(
  action: "submit" | "cancel",
  fields: SecretVariableField[],
  values: Record<string, string>,
): SecretReplyPayload {
  if (action === "cancel") return { secrets: null };
  const secrets: Record<string, string> = {};
  for (const field of fields) {
    secrets[field.name] = values[field.name] ?? "";
  }
  return { secrets };
}
