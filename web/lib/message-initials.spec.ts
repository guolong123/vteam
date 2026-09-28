import { test, expect } from "@playwright/test";
import { messageInitials } from "./message-initials";

/**
 * message-initials · B8 头像人名缩写纯逻辑门（lib-unit）
 * =============================================
 * chat-ux-hierarchy-and-streaming 复选框 10 · B8：
 * 缩写只能从「已解析的展示人名/别名」生成（页面侧 lib/display-author.ts 过滤裸 id 之后的字符串），
 * 规则：CJK 取首字符、拉丁取前两个字母并大写；只有「没有名字」才回落 undefined
 * （由 src/components/ui/agent-avatar.tsx 回落角色字母）。
 *
 * 运行：`npx playwright test lib/message-initials.spec.ts --project=lib-unit`
 * 失败语义：本模块改动前不存在 → import 即红（Cannot find module './message-initials'）。
 */

test("B8 CJK 名取首字符（含假名/谚文/扩展区，trim 后判定）", () => {
  expect(messageInitials("张伟")).toBe("张");
  expect(messageInitials("李静")).toBe("李");
  expect(messageInitials("田中太郎")).toBe("田");
  expect(messageInitials("김민수")).toBe("김");
  expect(messageInitials("  张伟  ")).toBe("张");
});

test("B8 拉丁名取前两个字母并大写（带音标字母同样算拉丁字母）", () => {
  expect(messageInitials("Alice")).toBe("AL");
  expect(messageInitials("aaron")).toBe("AA");
  expect(messageInitials("Bob")).toBe("BO");
  expect(messageInitials("Dev-1")).toBe("DE"); // 连字符/数字跳过，只取字母
  expect(messageInitials("Émile Zola")).toBe("ÉM");
  expect(messageInitials("A")).toBe("A"); // 单字母名只回一个字母
});

test("B8 同角色两名不同成员的缩写必须互不相同", () => {
  const cjkA = messageInitials("张伟");
  const cjkB = messageInitials("李静");
  expect(cjkA).toBeDefined();
  expect(cjkB).toBeDefined();
  expect(cjkA).not.toBe(cjkB);

  const latinA = messageInitials("Alice");
  const latinB = messageInitials("Aaron");
  expect(latinA).toBeDefined();
  expect(latinB).toBeDefined();
  expect(latinA).not.toBe(latinB);
});

test("B8 裸 id 永远不是人名：a_/tmm_/ta_ 一律不生成缩写（B9 no-raw-id 契约）", () => {
  expect(messageInitials("a_developer")).toBeUndefined();
  expect(messageInitials("tmm_1")).toBeUndefined();
  expect(messageInitials("ta_1234567")).toBeUndefined();
  expect(messageInitials("a_x")).toBeUndefined();
});

test("B8 只有「没有名字」才回落 undefined（AgentAvatar 再回落角色字母）", () => {
  expect(messageInitials(undefined)).toBeUndefined();
  expect(messageInitials(null)).toBeUndefined();
  expect(messageInitials("")).toBeUndefined();
  expect(messageInitials("   ")).toBeUndefined();
  expect(messageInitials(123)).toBeUndefined();
  expect(messageInitials({ name: "Alice" })).toBeUndefined();
});

test("B8 Unicode 安全：不切分代理对、不产生孤立代理项", () => {
  const extB = messageInitials("𠮷野家"); // U+20BB7 CJK 扩展 B（UTF-16 代理对）
  expect(extB).toBe("𠮷");
  expect(Array.from(extB ?? "")).toHaveLength(1);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(extB ?? "")).toBe(false);

  // 代理对字符前缀不影响后续拉丁字母取值
  expect(messageInitials("😀Bob")).toBe("BO");
});

test("B8 非 CJK/拉丁文字与纯数字符号名：仍从名字生成，不回退角色字母", () => {
  expect(messageInitials("Ольга")).toBe("ОЛ"); // 西里尔同样取前两个字母
  expect(messageInitials("123")).toBe("1"); // 无字母 → 首码点（名字派生，非角色字母）
});
