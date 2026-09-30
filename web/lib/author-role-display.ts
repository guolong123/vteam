/**
 * author-role-display：可见作者名与角色标签的「组件侧」展示决策（复选框 7 · B5/B9）
 * =============================================
 * 职责边界（本文件只被展示组件 MessageIdentity / ChatBubble 调用）：
 *   组件收到的 author 已由容器（session 页面）解析成 display 文本，
 *   本模块只回答两个纯展示问题——主文本用谁、角色标签要不要并列。
 *   不认识 a_/tmm_/ta_ 等业务 id 格式、不访问任何业务映射或数据源。
 *
 * B5 规则：
 *   - author 已解析且与角色标签不同 → 主文本 author + 并列角色标签；
 *   - author 已解析但与角色标签相同 → 只展示一次（去重）；
 *   - author 未解析（undefined/空）  → 主文本回落角色标签，不并列第二份。
 */

export interface AuthorRoleDisplay {
  /** 身份行主文本：author 有值用 author，否则回落角色标签 */
  primary: string;
  /** 与 primary 并列展示的角色标签；无需并列（未解析或已去重）时为 null */
  roleLabel: string | null;
}

export function authorRoleDisplay(
  author: string | undefined,
  roleLabel: string,
): AuthorRoleDisplay {
  const primary = typeof author === "string" ? author.trim() : "";
  const label = typeof roleLabel === "string" ? roleLabel.trim() : "";
  if (primary === "") {
    // 两者皆空（外部渠道消息且 senderId 缺失）：给中性兜底，避免渲染出空身份行。
    return { primary: label === "" ? UNKNOWN_AUTHOR : label, roleLabel: null };
  }
  if (label === "" || primary === label) {
    return { primary, roleLabel: null };
  }
  return { primary, roleLabel: label };
}

/** 作者名与角色标签皆不可解析时的中性兜底（非角色名，避免误显示为某岗位）。 */
const UNKNOWN_AUTHOR = "外部用户";
