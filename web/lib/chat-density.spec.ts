import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * chat-density · A1–A3 密度阈值纯检查（lib-unit）
 * =============================================
 * chat-ux-hierarchy-and-streaming 复选框 2 的纯逻辑侧证据：不渲染、不依赖后端/dev server，
 * 直接对产品源码做密度契约断言 + 计算校验（800/10/16em、2000、200）。
 * DOM 行为（折叠行数、展开后第 2001 字符起不出现）由 e2e/chat-density.spec.ts 覆盖。
 *
 * 运行：`npx playwright test lib/ --project=lib-unit`
 * 失败语义：改动前旧阈值（360/6/500/60）在此红，改动后（800/10/2000/200）转绿。
 */

/** 读取 web 根目录下的产品源码。 */
function readSource(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8");
}

/**
 * 把截断上限 token 解析成数字：
 * 纯数字字面量直接返回；常量名回源码匹配 `const NAME = 数字`（含 `export const`）。
 * 解析不到返回 null，交由断言暴露（而不是静默通过）。
 */
function resolveCap(source: string, token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);
  const m = source.match(
    new RegExp("(?:const|let)\\s+" + token + "\\s*=\\s*(\\d+)")
  );
  return m ? Number(m[1]) : null;
}

const bubble = readSource("src/components/ui/chat-bubble.tsx");
const parts = readSource("src/components/chat/msg-parts.tsx");
const thinking = readSource("src/components/chat/msg-thinking.tsx");

test("A1 正文密度：800 字符阈值 / WebkitLineClamp 仅一处且为 10 / 16em 与 10 行一致 / toggle 契约不变", () => {
  // 既有契约先守（改动前后都必须为真）：toggle copy 与 testid 不变
  expect(bubble).toContain('data-testid="chat-bubble-toggle"');
  expect(bubble).toContain('"收起 ▲"');
  expect(bubble).toContain('"展开 ▼"');

  const clampLines = (bubble.match(/WebkitLineClamp/g) ?? []).length;
  const threshold = bubble.match(/CHAT_COLLAPSE_THRESHOLD\s*=\s*(\d+)/)?.[1] ?? null;
  const collapse = bubble.match(
    /WebkitLineClamp:\s*(\d+)[\s\S]{0,160}?maxHeight:\s*"([\d.]+)em"/
  );
  const metrics = {
    clampLines, // 计划 QA failure：grep -c 'WebkitLineClamp' 必须为 1
    threshold, // 期望 800（改动前 360）
    lineClamp: collapse?.[1] ?? null, // 期望 10（改动前 6）
    maxHeightEm: collapse?.[2] ?? null, // 期望 16（改动前 9.6）
  };
  expect(metrics).toEqual({
    clampLines: 1,
    threshold: "800",
    lineClamp: "10",
    maxHeightEm: "16",
  });

  // 计算校验：maxHeight(em) = 行数 × 行高 1.6 → 16em 恰为 10 行
  const lineClamp = Number(metrics.lineClamp);
  const maxHeightEm = Number(metrics.maxHeightEm);
  expect(Math.round((maxHeightEm / 1.6) * 100) / 100).toBe(lineClamp);
  expect(Math.round((maxHeightEm / lineClamp) * 100) / 100).toBe(1.6);

  // 夹具边界：900 触发折叠，恰好 800 不触发（阈值为严格大于）
  expect(900).toBeGreaterThan(Number(metrics.threshold));
  expect(Number(metrics.threshold)).not.toBeGreaterThan(800);
});

test("A2 tool I/O 密度：字符串与 JSON 两条路径都封顶 2000 字符", () => {
  const tokens = [
    ...parts.matchAll(
      /value\.slice\(0,\s*([A-Za-z_0-9]+)\)|serialized\.slice\(0,\s*([A-Za-z_0-9]+)\)/g
    ),
  ].map((m) => m[1] ?? m[2] ?? "");
  const caps = tokens.map((t) => resolveCap(parts, t));

  expect.soft(tokens.length, "formatToolIO 应有两处截断（字符串路径 + JSON 路径）").toBe(2);
  expect
    .soft(caps, "两条路径的截断上限均应为 2000（改动前 [500, 500]）")
    .toEqual([2000, 2000]);

  // 调用方仍在封顶之内：input/output 均经共享 formatter 进入 MsgTool
  expect(parts).toMatch(/input=\{formatToolIO\(st\?\.input\)\}/);
  expect(parts).toMatch(/output=\{formatToolIO\(st\?\.output\)\}/);

  // 计算校验：3000 字符 payload → DOM 恰好前 2000，第 2001 起共 1000 字符缺席
  expect(3000 - Number(caps[0] ?? 0)).toBe(1000);
});

test("A3 thinking 密度：折叠摘录 200 字符 / 展开与 title 上限 2000 字符", () => {
  const tokens = [...thinking.matchAll(/\.slice\(0,\s*([A-Za-z_0-9]+)\)/g)].map(
    (m) => m[1] ?? ""
  );
  const caps = tokens.map((t) => resolveCap(thinking, t));

  expect
    .soft(caps, "thinking 应有两处截断：折叠摘录 200 + 展开/title 上限 2000（改动前 [60]）")
    .toEqual([200, 2000]);

  // title 不得再挂未截断的原始文本（改动前 title={text.trim()}，3000 字符会进 DOM）
  expect
    .soft(thinking, "title 必须走 2000 字符上限变量，而非未截断的 text.trim()")
    .not.toMatch(/title=\{text\.trim\(\)\}/);

  // 摘录与展开态都不得追加尾随省略号（否则 DOM 分别为 201/2001 字符，不再是精确的 200/2000）
  expect
    .soft(thinking, "折叠摘录不得拼接省略号（改动前 length > 60 ? \"…\"）")
    .not.toMatch(/\.length > \d+ \? "…"/);

  // 计算校验：3000 字符 thinking → 折叠时 201..3000 共 2800 字符缺席；展开时 2001..3000 共 1000 字符缺席
  expect(3000 - Number(caps[0] ?? 0)).toBe(2800);
  expect(3000 - Number(caps[1] ?? 0)).toBe(1000);
  expect(Number(caps[0] ?? 0)).toBeLessThan(Number(caps[1] ?? 0));
});

test("A4 三级字号源契约：消息作用域 14/12·600/11 与全局 fontSize.md=13 并存", () => {
  const tokens = readSource("src/theme/tokens.ts");

  const globalBlock = tokens.match(/export const fontSize = \{([\s\S]*?)\} as const;/)?.[1] ?? "";
  const msgBlock =
    tokens.match(/export const messageFontSize = \{([\s\S]*?)\} as const;/)?.[1] ?? "";
  const weightBlock =
    tokens.match(/export const messageFontWeight = \{([\s\S]*?)\} as const;/)?.[1] ?? "";
  const pick = (block: string, key: string): string | null =>
    block.match(new RegExp("\\b" + key + ":\\s*(\\d+)"))?.[1] ?? null;

  // 全局字号守门：md 必须仍为 13，且任何全局档都不得是 14（改动前无 messageFontSize → 此处红）
  expect(pick(globalBlock, "md")).toBe("13");
  expect([...globalBlock.matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1]))).not.toContain(14);
  expect({ body: pick(msgBlock, "body"), identity: pick(msgBlock, "identity"), meta: pick(msgBlock, "meta") })
    .toEqual({ body: "14", identity: "12", meta: "11" });
  expect(pick(weightBlock, "identity")).toBe("600");

  // ChatBubble 三级绑定：正文/身份/元信息分别挂消息作用域 token
  expect(bubble).toMatch(/fontSize:\s*messageFontSize\.body/);
  expect(bubble).toMatch(/fontSize:\s*messageFontSize\.identity/);
  expect(bubble).toMatch(/fontWeight:\s*messageFontWeight\.identity/);
  expect(bubble).toMatch(/fontSize:\s*messageFontSize\.meta/);

  // 时间戳拆成独立元信息元素（改动前是 author span 内无样式的裸 <span> · {time}</span>）
  expect(bubble).toContain('data-testid="chat-bubble-time"');
  expect(bubble).not.toMatch(/\{time \? <span> · \{time\}<\/span> : null\}/);
});
