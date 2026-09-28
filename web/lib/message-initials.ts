/**
 * message-initials：聊天头像「人名缩写」的生成规则（chat-ux-hierarchy-and-streaming 复选框 10 · B8）
 * =============================================
 * 职责边界（与 lib/display-author.ts 同一层，都是「页面侧」纯函数，展示组件不自己造名字）：
 *   只接受**已解析的展示人名/别名**——即页面用 agent/instance/team-member 三路映射取出、
 *   再经 resolveDisplayAuthor 过滤掉裸 id 之后的字符串；绝不接受 senderId/instanceId 作为输入。
 *   ChatBubble / MessageIdentity 拿到的 author 就是这条链路的产物，因此从它生成缩写
 *   不会把 a_xxx / tmm_xxx / ta_xx 变成可见字符（本模块再做一次裸 id 防御，双保险）。
 *
 * 生成规则（Unicode 安全、确定性，无 locale/环境依赖）：
 *   1. 非字符串 / trim 后为空 / 裸 id → undefined（调用方回落角色字母，见 agent-avatar.tsx）；
 *   2. 首码点命中 CJK（汉字、扩展 A/B、兼容区、假名、谚文）→ 取该单字符
 *      （一个方块字已足够辨识，28px 头像放不下两个 CJK 字）；
 *   3. 其余文字取前两个「字母」（\p{L}，含带音标拉丁字母、西里尔等）并转大写；
 *      ß 这类单字形大写后会变两个字符（SS），保留原字形以保证缩写恒 ≤2 个码点；
 *   4. 名字里一个字母都没有（纯数字/符号）→ 取首码点（仍是名字派生，不回退角色字母）。
 *
 * 失败语义：只有「没有名字」才返回 undefined —— agent-avatar.tsx 的
 * `initials ?? 角色字母` 只在这一种情况下生效，同角色不同成员因此不会撞成同一个字母。
 */

import { RAW_SENDER_ID_PATTERN } from "./display-author";

/** 首字符属于该集合时按 CJK 单字缩写（汉字 URO/扩展 A/扩展 B/兼容、假名、谚文）。 */
const CJK_LEADING =
  /^[\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{1100}-\u{11FF}\u{3130}-\u{318F}\u{AC00}-\u{D7AF}\u{20000}-\u{2A6DF}]/u;

/** 任意文字系统的字母（非全局正则：可反复 .test 而无 lastIndex 状态残留）。 */
const LETTER = /\p{L}/u;

/**
 * 由已解析的人名/别名生成头像缩写；不可生成时返回 undefined（回落角色字母）。
 * 入参 unknown 是刻意的：容器可能从任意映射里取出候选，非字符串必须安全落到 undefined。
 */
export function messageInitials(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  if (trimmed === "") return undefined;
  // B9 no-raw-id：裸 id 永远不是可展示人名，也就永远不能变成头像缩写。
  // 用 display-author 导出的同一正则直接判定（不用 isRawSenderId 谓词：对已是 string 的值做
  // `value is string` 反向收窄会把剩余分支压成 never，见本文件 tsc 修复记录）
  if (RAW_SENDER_ID_PATTERN.test(trimmed)) return undefined;

  const codePoints = Array.from(trimmed); // 按码点切分：不拆代理对
  const first = codePoints[0];
  if (CJK_LEADING.test(first)) return first;

  const picked: string[] = [];
  for (const ch of codePoints) {
    if (!LETTER.test(ch)) continue; // 空格/连字符/数字/标点跳过
    const upper = ch.toUpperCase();
    picked.push(upper.length === 1 ? upper : ch); // ß→SS 这类扩张字形保留原样，恒 ≤2 码点
    if (picked.length === 2) break;
  }
  if (picked.length > 0) return picked.join("");

  return first.toUpperCase(); // 无字母的名字：仍从名字取首码点
}
