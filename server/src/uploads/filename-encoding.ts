/**
 * multipart 文件名编码修复（latin1 / UTF-8 错位）。
 *
 * ## 现象
 * 浏览器提交 multipart 时把中文文件名按 **UTF-8 字节**写进 `filename="..."`，
 * 而 multer 2.x 内部的 busboy 1.x 默认按 **latin1** 解码该参数 ⇒
 * `需求说明.md` 被解成 `éœ€æ±‚è¯´æ˜Ž.md`（每个汉字的 3 个 UTF-8 字节被当成 3 个
 * U+0080–U+00FF 字符）。这条错误字符串会一路落库（`messages.attachments[].name`）、
 * 进后续 DTO / MCP chat_history / worker prompt，最终在 UI 与模型上下文里显示成乱码。
 *
 * multer 把 options 只透传 `{headers,limits,preservePath}`，无法给 busboy 传
 * `defParamCharset: 'utf8'`（`server/node_modules/multer/lib/make-middleware.js`），
 * 故在控制面统一做**形态可逆的解码修复**。
 *
 * ## 修法
 * 仅当字符串**完全落在 latin1 区（每个 code unit ≤ 0xFF）**、含 ≥1 个非 ASCII 字符，
 * 且把这些 code unit 当字节重新按 UTF-8 解码**成功**（无替换符 U+FFFD）时才替换：
 * - 已经是合法中文/其它 Unicode（含 > 0xFF 的码位）→ 原样返回；
 * - 真正的 latin1 文本（如 `café`：单字节 0xE9 不是合法 UTF-8 序列）→ 原样返回；
 * - 修复结果不含非 ASCII → 原样返回（避免无意义转换）；
 * - 修复后再次调用：结果含 > 0xFF 码位 → 命中第一条，原样返回 ⇒ **幂等**。
 *
 * @module uploads/filename-encoding
 */

/** 判断字符串是否完全落在 latin1 码位区（每个 code unit ≤ 0xFF）。 */
function isLatin1Range(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

/**
 * 修复 multipart 文件名/字段值的 latin1→UTF-8 错位解码（幂等；不合法/无变化时原样返回）。
 *
 * 除文件名外也可用于 busboy 以 latin1 解码的其它文本参数（如中文 title）。
 */
export function repairMultipartText(value: string): string {
  if (!value) return value;
  // 快速路径：纯 ASCII 无需处理（覆盖绝大多数文件名）
  if (!/[\u0080-\u00ff]/.test(value)) return value;
  // 含 > 0xFF 码位 = 已是真正的 Unicode（中文/emoji 等），不是 latin1 错位形态
  if (!isLatin1Range(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  // 解码失败（非法 UTF-8 序列）= 原本就是真正的 latin1 文本，保持原样
  if (decoded.includes('\uFFFD')) return value;
  // 解码结果必须真的恢复出非 ASCII 内容，否则视为无意义转换
  if (!/[^\u0000-\u007f]/.test(decoded)) return value;
  return decoded;
}
