import { test, expect, type Page, type Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * chat-density · A1–A3 密度阈值 + A4 三级字号 DOM 门（chat-ux-hierarchy-and-streaming 复选框 2/3）
 * =============================================
 * 覆盖：
 *  - A1 正文：900 字符正文出现 chat-bubble-toggle，折叠态 WebkitLineClamp=10 / maxHeight=16em
 *    （= 10 行 × 行高 1.6，几何换算与实际裁剪高度双重断言），点击展开后 clamp 清除；
 *    恰好 800 字符不触发折叠。
 *  - A2 tool I/O：3000 字符 payload（字符串路径 + JSON 路径），折叠态与展开态都只把
 *    前 2000 字符放进 DOM，第 2001 字符起不出现，title 同样 ≤2000。
 *  - A3 thinking：折叠摘录恰好 200 字符；展开态 DOM 恰好为完整 2000 字符摘录，
 *    第 2001 字符起（含 title 属性）不进入 DOM；既有折叠文案保留。
 *  - A4 三级字号：正文 computed 14px、身份 12px/600、元信息 11px，三者字号互不相同；
 *    时间戳是独立元信息元素（chat-bubble-time，不在作者 span 内，不与身份共享
 *    fontSize+color 同值）；全局 fontSize 档位（md=13 等）不被消息密度改写。
 *  - B1 共享身份栏（复选框 4）：含 reasoning + tool + text 的单条 agent 消息只渲染
 *    1 个 agent-avatar / 1 个 chat-bubble-author / 1 个 chat-bubble-time，作者名与时间
 *    的可见 leaf 也各只出现 1 次；msg-thinking / msg-tool / chat-bubble-content 等过程
 *    testid 仍各存在（附属行只降级身份，不吞内容）。
 *  - B7 用户消息状态（复选框 10）：`ChatBubble` 可选 `status`，user 消息在
 *    sending/sent/failed 三个取值时渲染 1 个 `chat-bubble-status`（`data-status` + 可读中文
 *    文案 + `role="status"`）；缺省状态与 pending/processing/completed/未知状态一律 0 个标记；
 *    标记是正文之外的文档流兄弟节点（position static、位于气泡下沿之外、11px 元信息级），
 *    有无状态时 `chat-bubble-content` 与 `chat-bubble` 的 boundingBox 逐像素相同。
 *  - B8 人名缩写（复选框 10）：`ChatBubble` 可选 `initials`、`MsgParts` 透传 `initials`；
 *    fixture 用生产同款 `lib/message-initials.ts` 从已解析人名生成缩写：
 *    同角色两名成员 CJK（张/李）与拉丁（AL/AA）缩写互不相同且可见名字正确；
 *    解析不到名字时回落角色字母，渲染后的 DOM（#root innerHTML/innerText）不含任何
 *    `a_`/`tmm_`/`ta_` 裸 id；agent 消息不渲染用户状态标记。
 *  - B6 未知 part（复选框 9）：patch / step-start / step-finish / 未识别 type 各渲染
 *    1 个 msg-unknown-part（改动前 dispatcher 末尾 return null → 0 个），带安全
 *    data-part-type 与可见类型标签；默认 aria-expanded=false 且摘要不进 DOM，
 *    展开只给 ≤400 字符的 JSON 摘要（超长 payload 第 401 字符起不进 DOM），
 *    收起后摘要离开 DOM；恶意 type 不产生标记注入；同 fixture 的
 *    reasoning / tool / text 已知分支计数与 testid 一个不变。
 *  - B11 统一折叠策略（复选框 12）：thinking/tool/unknown/长附件默认收起且可展开
 *    （展开区各有 msg-thinking-detail / msg-tool-io / msg-unknown-part-summary /
 *    attachment-file + attachment-detail-toggle）；主正文/流式正文/system 全文在 DOM
 *    且无收起开关；error/aborted 标题·状态·操作始终可见，超长 detail 的
 *    msg-error-detail / msg-aborted-detail 默认展开（aria-expanded=true），收起只
 *    摘掉 detail 区；短内容不出现任何开关。
 *
 * 密度测试缝（test seam，自包含）：用已声明依赖 esbuild-wasm 把真实产品组件
 * （MsgParts → ChatBubble/MsgTool/MsgThinking）打包成 IIFE，注入空白页 #root 由 React
 * 挂载后交互断言——真实浏览器、真实组件树，但不依赖 setup 登录态、后端或 dev server
 * 路由（后端 :3000 未监听时依然可跑）。
 *
 * 运行：`npx playwright test chat-density.spec.ts --project=chat-density`
 * 失败语义：改动前旧阈值（360/6/500/60）与旧字号（正文 13/身份 11、无独立时间元信息）在此红；
 * 改动后（800/10/16em/2000/200、14/12·600/11）转绿。
 * B1 失败语义：改动前单条 reasoning+tool+text 消息的 agent-avatar 计数为 3、
 * 作者名与时间的可见 leaf 分别为 2/3（process part 各自带身份）→ 在此红；
 * MsgParts 共享身份栏落地后各计数归 1 转绿。
 * B6 失败语义：改动前 msg-unknown-part 计数为 0（未知 part 被静默丢弃）→ 在此红；
 * MsgParts 未知分支落地后计数/收起/封顶断言全部转绿。
 * B7 失败语义：改动前 `ChatBubble` 没有 status prop → 任何状态下 chat-bubble-status 计数 0
 * （sending/sent/failed 三条标记断言与几何断言在此红）。
 * B8 失败语义：改动前 `MsgParts` 不接收 initials、`ChatBubble` 没有 initials prop →
 * 头像一律显示角色字母 D（张/李、AL/AA、ZZ 五条断言在此红）。
 * B11 失败语义：改动前 attachment-detail-toggle / msg-error-detail-toggle /
 * msg-aborted-detail-toggle 计数为 0（长附件、超长 error/aborted 没有折叠开关）→
 * 这三格在此红；thinking/tool/unknown/正文/流式/system 六格是既有行为的回归锁。
 */

declare global {
  interface Window {
    __density: {
      render: (kind: string, payload: string) => void;
      /** 产品 tokens 快照（A4 守门：全局 fontSize 档位不得被消息字号改写） */
      tokens: { fontSize: Record<string, number> };
    };
  }
}

type Kind =
  | "body"
  | "tool"
  | "tool-json"
  | "thinking"
  | "identity"
  | "unknown"
  | "unknown-huge"
  | "unknown-hostile"
  | "user-status"
  | "user-plain"
  | "initials-cjk"
  | "initials-latin"
  | "initials-fallback"
  | "initials-override"
  // ---- B11 统一折叠策略（复选框 12）----
  | "attachment-long"
  | "attachment-short"
  | "error-long"
  | "error-short"
  | "error-retry"
  | "error-failed"
  | "aborted-long"
  | "aborted-short"
  | "streaming-long"
  | "system-long";

const WEB_ROOT = process.cwd();

/**
 * 测试缝入口（运行期由 esbuild-wasm 以 tsx 编译，不入库为产品文件）。
 * 只渲染本 todo 关心的链路，全部走生产渲染器 MsgParts：
 * text → ChatBubble（A1）、tool → MsgTool（A2，经共享 formatToolIO）、
 * reasoning → MsgThinking（A3）、reasoning+tool+text → 共享身份栏（B1）。
 */
const HARNESS_SOURCE = `
import { createRoot, type Root } from "react-dom/client";
import { MsgParts } from "@/src/components/chat/msg-parts";
import { ChatBubble } from "@/src/components/ui/chat-bubble";
import { messageInitials } from "@/lib/message-initials";
import { fontSize } from "@/src/theme/tokens";

type Kind =
  | "body"
  | "tool"
  | "tool-json"
  | "thinking"
  | "identity"
  | "unknown"
  | "unknown-huge"
  | "unknown-hostile"
  | "user-status"
  | "user-plain"
  | "initials-cjk"
  | "initials-latin"
  | "initials-fallback"
  | "initials-override"
  | "attachment-long"
  | "attachment-short"
  | "error-long"
  | "error-short"
  | "error-retry"
  | "error-failed"
  | "aborted-long"
  | "aborted-short"
  | "streaming-long"
  | "system-long";

function Fixture({ kind, payload }: { kind: Kind; payload: string }) {
  const meta = { author: "密度", role: "developer" as const, time: "12:00" };
  if (kind === "body") {
    return <MsgParts {...meta} parts={[{ type: "text", text: payload }]} />;
  }
  if (kind === "tool") {
    return (
      <MsgParts
        {...meta}
        parts={[
          { type: "tool", state: { status: "success", input: "", output: payload }, name: "density_tool" },
        ]}
      />
    );
  }
  if (kind === "tool-json") {
    return (
      <MsgParts
        {...meta}
        parts={[
          {
            type: "tool",
            state: { status: "success", input: { q: payload }, output: { blob: payload } },
            name: "density_tool",
          },
        ]}
      />
    );
  }
  if (kind === "identity") {
    return (
      <MsgParts
        {...meta}
        parts={[
          { type: "reasoning", state: "done", text: "推理内容" },
          {
            type: "tool",
            state: { status: "success", input: "in", output: "out" },
            name: "identity_tool",
          },
          { type: "text", text: "最终结论" },
        ]}
      />
    );
  }
  if (kind === "unknown") {
    return (
      <MsgParts
        {...meta}
        parts={[
          { type: "patch", path: "src/app/page.tsx", diff: payload },
          { type: "step-start", step: "plan" },
          { type: "step-finish", status: "success" },
          { type: 'x"><img src=x onerror=window.__pwned=1>', note: "hostile" },
          { type: "reasoning", state: "done", text: "已知推理分支" },
          {
            type: "tool",
            state: { status: "success", input: "in", output: "out" },
            name: "known_tool",
          },
          { type: "text", text: "已知正文分支" },
        ]}
      />
    );
  }
  if (kind === "unknown-huge") {
    return <MsgParts {...meta} parts={[{ type: "patch", path: "big.ts", diff: payload }]} />;
  }
  if (kind === "unknown-hostile") {
    return (
      <MsgParts
        {...meta}
        parts={[{ type: 'x"><img src=x onerror=window.__pwned=1>', note: "hostile" }]}
      />
    );
  }
  if (kind === "attachment-long" || kind === "attachment-short") {
    return (
      <MsgParts
        {...meta}
        parts={[]}
        attachment={{ url: "/uploads/attachment.pdf", name: payload, size: 123456, ext: "pdf" }}
      />
    );
  }
  if (kind === "error-long" || kind === "error-short") {
    return <MsgParts {...meta} parts={[{ type: "error", kind: "quota", detail: payload }]} />;
  }
  if (kind === "error-retry") {
    return <MsgParts {...meta} parts={[{ type: "error", kind: "retry", detail: payload }]} />;
  }
  if (kind === "error-failed") {
    return <MsgParts {...meta} messageStatus="failed" parts={[{ type: "text", text: payload }]} />;
  }
  if (kind === "aborted-long" || kind === "aborted-short") {
    return <MsgParts {...meta} parts={[{ type: "aborted", detail: payload }]} />;
  }
  if (kind === "streaming-long") {
    return <MsgParts {...meta} streaming parts={[{ type: "text", text: payload }]} />;
  }
  if (kind === "system-long") {
    return <ChatBubble type="system" text={payload} time="12:00" />;
  }
  // ---- B7 用户消息状态标记（复选框 10）----
  if (kind === "user-status") {
    return <ChatBubble type="user" text="用户消息正文" status={payload} />;
  }
  if (kind === "user-plain") {
    return <ChatBubble type="user" text="用户消息正文" />;
  }
  // ---- B8 头像人名缩写（复选框 10）----
  if (kind === "initials-cjk") {
    // 与会话页同一套组合：initials = messageInitials(已解析 author)
    return (
      <div>
        <MsgParts author="张伟" role="developer" time="12:00" initials={messageInitials("张伟")} parts={[{ type: "text", text: "甲的结论" }]} />
        <MsgParts author="李静" role="developer" time="12:01" initials={messageInitials("李静")} parts={[{ type: "text", text: "乙的结论" }]} />
      </div>
    );
  }
  if (kind === "initials-latin") {
    return (
      <div>
        <MsgParts author="Alice" role="developer" time="12:00" initials={messageInitials("Alice")} parts={[{ type: "text", text: "alpha 的结论" }]} />
        <MsgParts author="Aaron" role="developer" time="12:01" initials={messageInitials("Aaron")} parts={[{ type: "text", text: "aaron 的结论" }]} />
      </div>
    );
  }
  if (kind === "initials-fallback") {
    // 页面解析不到人名（候选全是裸 id，被 resolveDisplayAuthor 丢弃）→ 缩写 undefined → 角色字母
    const name = undefined;
    return <MsgParts role="developer" time="12:00" initials={messageInitials(name)} parts={[{ type: "text", text: "无名消息" }]} />;
  }
  if (kind === "initials-override") {
    // ChatBubble 显式 initials 优先；未传时由 AgentAvatar 回落角色字母
    return (
      <div>
        <ChatBubble type="agent" text="显式缩写" author="张伟" role="developer" time="12:00" initials="ZZ" />
        <ChatBubble type="agent" text="缺省缩写" author="李静" role="developer" time="12:01" />
      </div>
    );
  }
  return <MsgParts {...meta} parts={[{ type: "reasoning", state: "done", text: payload }]} />;
}

let root: Root | null = null;
function render(kind: string, payload: string): void {
  const host = document.getElementById("root");
  if (!host) throw new Error("density harness: #root not found");
  if (!root) root = createRoot(host);
  root.render(<Fixture kind={kind as Kind} payload={payload} />);
}

(window as unknown as {
  __density: {
    render: (k: string, p: string) => void;
    tokens: { fontSize: Record<string, number> };
  };
}).__density = {
  render,
  tokens: { fontSize: { ...fontSize } },
};
`;

/** 最小样式底座：对齐生产 globals.css（tailwind preflight 的 box-sizing/margin 归零）。 */
const HARNESS_HTML =
  '<div id="root"></div>' +
  "<style>" +
  "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}" +
  "html{line-height:1.5;-webkit-text-size-adjust:100%}" +
  "body{font-family:ui-sans-serif,system-ui,sans-serif}" +
  "</style>";

let harnessBundle: Promise<string> | null = null;

/** 用已安装的 esbuild-wasm 把测试缝入口打包成浏览器可执行的 IIFE（不落盘、不新增依赖）。 */
function buildHarness(): Promise<string> {
  if (!harnessBundle) {
    harnessBundle = (async () => {
      const esbuild = await import("esbuild-wasm");
      const result = await esbuild.build({
        stdin: {
          contents: HARNESS_SOURCE,
          loader: "tsx",
          resolveDir: WEB_ROOT,
          sourcefile: "chat-density-harness.tsx",
        },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2020",
        // tsconfig 的 jsx: preserve 不适用于浏览器 IIFE：显式转 automatic runtime
        jsx: "automatic",
        charset: "utf8",
        define: {
          "process.env.NODE_ENV": '"production"',
          // lib/api.ts 模块级读取；浏览器无 process 全局
          "process.env.NEXT_PUBLIC_API_BASE_URL": "undefined",
        },
        tsconfig: path.join(WEB_ROOT, "tsconfig.json"),
        logLevel: "silent",
      });
      const files = result.outputFiles ?? [];
      if (files.length === 0) throw new Error("density harness: esbuild 无输出");
      return Buffer.from(files[0].contents).toString("utf8");
    })();
  }
  return harnessBundle;
}

async function mountHarness(page: Page): Promise<void> {
  const script = await buildHarness();
  await page.setContent(HARNESS_HTML);
  await page.addScriptTag({ content: script });
}

async function renderFixture(page: Page, kind: Kind, payload: string): Promise<void> {
  await page.evaluate(
    (input) => window.__density.render(input.kind, input.payload),
    { kind, payload }
  );
}

/** A1 折叠态：clamp、maxHeight、行高几何、实际裁剪行数与 toggle aria 快照。 */
interface BodyCollapsedMetrics {
  lineClamp: string;
  maxHeightStyle: string;
  lineHeightRatio: number | null;
  maxHeightInLines: number | null;
  visibleLines: number | null;
  toggleAria: string | null;
}

async function measureBodyCollapsed(content: Locator): Promise<BodyCollapsedMetrics> {
  return content.evaluate((el: HTMLElement) => {
    const cs = window.getComputedStyle(el);
    const fontSizePx = parseFloat(cs.fontSize);
    const lineHeightPx = parseFloat(cs.lineHeight);
    const rawMaxHeight = cs.maxHeight; // 折叠态 "16em" 或已解析 px；展开态 "none"
    const maxHeightPx = rawMaxHeight.endsWith("em")
      ? parseFloat(rawMaxHeight) * fontSizePx
      : parseFloat(rawMaxHeight);
    const toggle = el.nextElementSibling;
    return {
      lineClamp: el.style.getPropertyValue("-webkit-line-clamp"),
      maxHeightStyle: el.style.maxHeight,
      lineHeightRatio:
        Number.isFinite(lineHeightPx) && fontSizePx > 0
          ? Math.round((lineHeightPx / fontSizePx) * 100) / 100
          : null,
      maxHeightInLines:
        Number.isFinite(maxHeightPx) && Number.isFinite(lineHeightPx)
          ? Math.round((maxHeightPx / lineHeightPx) * 100) / 100
          : null,
      visibleLines:
        Number.isFinite(lineHeightPx) && lineHeightPx > 0
          ? Math.round(el.offsetHeight / lineHeightPx)
          : null,
      toggleAria: toggle ? toggle.getAttribute("aria-expanded") : null,
    };
  });
}

/** A1 展开态：clamp/maxHeight 清除、内容高度超过折叠时的 10 行窗口。 */
interface BodyExpandedMetrics {
  lineClamp: string;
  maxHeightStyle: string;
  lineHeightRatio: number | null;
  beyondClippedHeight: boolean;
  toggleAria: string | null;
}

async function measureBodyExpanded(content: Locator): Promise<BodyExpandedMetrics> {
  return content.evaluate((el: HTMLElement) => {
    const cs = window.getComputedStyle(el);
    const fontSizePx = parseFloat(cs.fontSize);
    const lineHeightPx = parseFloat(cs.lineHeight);
    const toggle = el.nextElementSibling;
    return {
      lineClamp: el.style.getPropertyValue("-webkit-line-clamp"),
      maxHeightStyle: el.style.maxHeight,
      lineHeightRatio:
        Number.isFinite(lineHeightPx) && fontSizePx > 0
          ? Math.round((lineHeightPx / fontSizePx) * 100) / 100
          : null,
      // 展开后无 max-height（computed = none），改用折叠窗口（10 × 行高）作几何基准
      beyondClippedHeight:
        Number.isFinite(lineHeightPx) && lineHeightPx > 0
          ? el.offsetHeight > 10 * lineHeightPx
          : false,
      toggleAria: toggle ? toggle.getAttribute("aria-expanded") : null,
    };
  });
}

/** A2：tool 卡片 DOM 内 2000 字符封顶快照（字符串与 JSON 两条路径共用字段）。 */
interface ToolMetrics {
  aria: string;
  hasFirst2000: boolean;
  hasAfter2000: boolean;
  exactFirst2000Span: boolean;
  titleLen: number;
  titleIsFirst2000: boolean;
}

async function measureTool(
  card: Locator,
  expected: { first: string; after: string }
): Promise<ToolMetrics> {
  return card.evaluate((el: HTMLElement, exp) => {
    const text = el.textContent ?? "";
    const title = el.querySelector("[title]")?.getAttribute("title") ?? "";
    return {
      aria: el.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? "",
      hasFirst2000: text.includes(exp.first),
      hasAfter2000: text.includes(exp.after),
      exactFirst2000Span: Array.from(el.querySelectorAll("span")).some(
        (s) => s.textContent === exp.first
      ),
      titleLen: title.length,
      titleIsFirst2000: title === exp.first,
    };
  }, expected);
}

/** A2 JSON 路径：折叠态 summary/title 与展开态 input/output 各自 2000 封顶。 */
interface ToolJsonMetrics {
  aria: string;
  summaryIsInputFirst2000: boolean;
  titleLen: number;
  titleIsInputFirst2000: boolean;
  inputSpanIs2000: boolean;
  outputSpanIs2000: boolean;
  hasAfter2000: boolean;
}

async function measureToolJson(
  card: Locator,
  expected: { inputFirst: string; outputFirst: string; inputAfter: string; outputAfter: string }
): Promise<ToolJsonMetrics> {
  return card.evaluate((el: HTMLElement, exp) => {
    const text = el.textContent ?? "";
    const titleEl = el.querySelector("[title]");
    const title = titleEl?.getAttribute("title") ?? "";
    const spans = Array.from(el.querySelectorAll("span")).map((s) => s.textContent ?? "");
    return {
      aria: el.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? "",
      summaryIsInputFirst2000: (titleEl?.textContent ?? "") === exp.inputFirst,
      titleLen: title.length,
      titleIsInputFirst2000: title === exp.inputFirst,
      inputSpanIs2000: spans.includes(exp.inputFirst),
      outputSpanIs2000: spans.includes(exp.outputFirst),
      hasAfter2000: text.includes(exp.inputAfter) || text.includes(exp.outputAfter),
    };
  }, expected);
}

/** 连续 CJK 码点串：逐字唯一，slice(2000) 不可能被 slice(0,2000) 包含，缺席断言无假阳性。 */
function cjk(length: number, start = 0x4e00): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(start + i);
  return out;
}

const BODY_900 = cjk(900); // 0x4E00..0x5183，> 800 → 触发折叠
const BODY_800 = cjk(800); // 恰好 800，严格大于才触发 → 不折叠
const TOOL_3000 = cjk(3000, 0x5000); // 0x5000..0x5BAB
const THINK_3000 = cjk(3000, 0x6000); // 0x6000..0x6BAC，无空白 → 摘录归一化为恒等

const TOOL_FIRST_2000 = TOOL_3000.slice(0, 2000);
const TOOL_AFTER_2000 = TOOL_3000.slice(2000);
const THINK_FIRST_200 = THINK_3000.slice(0, 200);
const THINK_FIRST_2000 = THINK_3000.slice(0, 2000);
const THINK_AFTER_2000 = THINK_3000.slice(2000);

/** B6 未知 part：与产品 `UNKNOWN_PART_SUMMARY_MAX_CHARS` 对齐的字面量契约（第 401 字符起不进 DOM）。 */
const UNKNOWN_SUMMARY_MAX = 400;
/** 折叠态不得出现在 DOM 的 payload 标记（ASCII，JSON 序列化后原样保留）。 */
const UNKNOWN_MARKER = "PATCH_PAYLOAD_MARKER_9f3a";
/** 超长 patch payload：5000 个逐字唯一 CJK 码点，远超 400 封顶。 */
const HUGE_PAYLOAD = cjk(5000, 0x7000); // 0x7000..0x8387
const HUGE_HEAD = HUGE_PAYLOAD.slice(0, 50);
/** 摘要（前缀 40 字符 + payload 前 360 字符）之后必然缺席的窗口。 */
const HUGE_PAST_BOUND = HUGE_PAYLOAD.slice(UNKNOWN_SUMMARY_MAX, UNKNOWN_SUMMARY_MAX + 20);

test("A1 正文 900 字符：toggle 存在，折叠态 10 行 clamp/16em（行高 1.6 几何一致），展开后清除", async ({
  page,
}) => {
  await mountHarness(page);
  await renderFixture(page, "body", BODY_900);

  const bubble = page.getByTestId("chat-bubble");
  const content = page.getByTestId("chat-bubble-content");
  const toggle = page.getByTestId("chat-bubble-toggle");
  await expect(bubble).toBeVisible();
  await expect(content).toBeVisible();
  await expect(toggle).toBeVisible();

  // 折叠态文案（既有 copy，改动前后不变）
  await expect(toggle).toHaveText("展开 ▼");

  const collapsed = await measureBodyCollapsed(content);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const expanded = await measureBodyExpanded(content);

  expect(collapsed).toEqual({
    lineClamp: "10", // 改动前 "6"
    maxHeightStyle: "16em", // 改动前 "9.6em"
    lineHeightRatio: 1.6, // bubbleBase lineHeight: 1.6
    maxHeightInLines: 10, // 16em ÷ (1.6 × fontSize) = 10 行
    visibleLines: 10, // 实际裁剪高度 ≈ 10 行（改动前 6）
    toggleAria: "false",
  });
  expect(expanded).toEqual({
    lineClamp: "",
    maxHeightStyle: "",
    lineHeightRatio: 1.6,
    beyondClippedHeight: true, // 900 字符展开后高度 > 折叠时的 16em
    toggleAria: "true",
  });

  // 展开态文案
  await expect(toggle).toHaveText("收起 ▲");
});

test("A1 阈值边界：恰好 800 字符正文不出现 chat-bubble-toggle", async ({ page }) => {
  await mountHarness(page);
  await renderFixture(page, "body", BODY_800);

  await expect(page.getByTestId("chat-bubble")).toBeVisible();
  await expect(page.getByTestId("chat-bubble-content")).toBeVisible();
  // 改动前阈值 360 → 800 字符会错误地出现 toggle（failing-first 红点）
  await expect(page.getByTestId("chat-bubble-toggle")).toHaveCount(0);
});

test("A2 tool I/O 字符串路径 3000 字符：折叠与展开都只放前 2000 字符进 DOM", async ({
  page,
}) => {
  await mountHarness(page);
  await renderFixture(page, "tool", TOOL_3000);

  const card = page.getByTestId("msg-tool");
  await expect(card).toBeVisible();
  const exp = { first: TOOL_FIRST_2000, after: TOOL_AFTER_2000 };

  const collapsed = await measureTool(card, exp);
  await card.locator("button[aria-expanded]").click();
  await expect(card.locator("button[aria-expanded]")).toHaveAttribute("aria-expanded", "true");
  const expanded = await measureTool(card, exp);

  expect(collapsed).toEqual({
    aria: "false",
    hasFirst2000: true, // 改动前只有 500 → false
    hasAfter2000: false,
    exactFirst2000Span: true, // 改动前 summary 为 500+"…" → false
    titleLen: 2000, // 改动前 501
    titleIsFirst2000: true,
  });
  expect(expanded).toEqual({
    aria: "true",
    hasFirst2000: true,
    hasAfter2000: false,
    exactFirst2000Span: true, // 输出 span 恰好 2000 字符（不追加省略号）
    titleLen: 2000,
    titleIsFirst2000: true,
  });
});

test("A2 tool I/O JSON 路径 3000 字符：序列化后同样 2000 封顶，2001+ 不进 DOM", async ({
  page,
}) => {
  await mountHarness(page);
  await renderFixture(page, "tool-json", TOOL_3000);

  const card = page.getByTestId("msg-tool");
  await expect(card).toBeVisible();
  const jsonInput = JSON.stringify({ q: TOOL_3000 });
  const jsonOutput = JSON.stringify({ blob: TOOL_3000 });
  const exp = {
    inputFirst: jsonInput.slice(0, 2000),
    outputFirst: jsonOutput.slice(0, 2000),
    inputAfter: jsonInput.slice(2000),
    outputAfter: jsonOutput.slice(2000),
  };

  const collapsed = await measureToolJson(card, exp);
  await card.locator("button[aria-expanded]").click();
  await expect(card.locator("button[aria-expanded]")).toHaveAttribute("aria-expanded", "true");
  const expanded = await measureToolJson(card, exp);

  expect(collapsed).toEqual({
    aria: "false",
    summaryIsInputFirst2000: true, // 改动前 500+"…" → false
    titleLen: 2000, // 改动前 501
    titleIsInputFirst2000: true,
    inputSpanIs2000: true,
    outputSpanIs2000: false, // 折叠态只展示 summary（输入）
    hasAfter2000: false,
  });
  expect(expanded).toEqual({
    aria: "true",
    summaryIsInputFirst2000: true,
    titleLen: 2000,
    titleIsInputFirst2000: true,
    inputSpanIs2000: true, // 序列化输入恰好 2000
    outputSpanIs2000: true, // 序列化输出恰好 2000
    hasAfter2000: false, // 第 2001 字符起不进 DOM
  });
});

test("A3 thinking 3000 字符：折叠摘录恰好 200，展开恰好完整 2000，2001+ 不进 DOM", async ({
  page,
}) => {
  await mountHarness(page);
  await renderFixture(page, "thinking", THINK_3000);

  const card = page.getByTestId("msg-thinking");
  await expect(card).toBeVisible();
  await expect(card.getByText("已思考 · 点击展开 ▸")).toBeVisible(); // 既有折叠文案

  const collapsed = await card.evaluate(
    (el: HTMLElement, exp: { excerpt: string; title: string; after: string }) => {
      const titleEl = el.querySelector("[title]");
      const title = titleEl?.getAttribute("title") ?? "";
      const text = el.textContent ?? "";
      const excerpt = titleEl?.textContent ?? "";
      return {
        aria: el.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? "",
        excerptLen: excerpt.length,
        excerptIs200: excerpt === exp.excerpt, // 恰好 = 原文前 200 字符，无省略号
        titleLen: title.length,
        titleIs2000: title === exp.title, // title 封顶 2000
        hasAfter2000: text.includes(exp.after), // 第 2001 字符起不得出现在 DOM
      };
    },
    { excerpt: THINK_FIRST_200, title: THINK_FIRST_2000, after: THINK_AFTER_2000 }
  );

  expect(collapsed).toEqual({
    aria: "false",
    excerptLen: 200, // 改动前 61（60 + "…"）
    excerptIs200: true, // 改动前 false
    titleLen: 2000, // 改动前 3000（完整 text 进 title）
    titleIs2000: true,
    hasAfter2000: false,
  });

  await card.locator("button[aria-expanded]").click();
  await expect(card.locator("button[aria-expanded]")).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByText("▾ 收起")).toBeVisible();

  const expanded = await card.evaluate(
    (el: HTMLElement, exp: { full: string; title: string; after: string }) => {
      const title = el.querySelector("[title]")?.getAttribute("title") ?? "";
      const text = el.textContent ?? "";
      return {
        aria: el.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? "",
        hasExact2000Div: Array.from(el.querySelectorAll("div")).some(
          (d) => d.textContent === exp.full
        ), // 展开 div 恰好 = 完整 2000 字符摘录（不含省略号）
        hasAfter2000: text.includes(exp.after), // 第 2001 字符起不得出现在 DOM
        titleLen: title.length,
        titleIs2000: title === exp.title,
      };
    },
    { full: THINK_FIRST_2000, title: THINK_FIRST_2000, after: THINK_AFTER_2000 }
  );

  expect(expanded).toEqual({
    aria: "true",
    hasExact2000Div: true, // 改动前展开为完整 3000 → 该 div 长度 3000 → false
    hasAfter2000: false, // 改动前 true
    titleLen: 2000,
    titleIs2000: true,
  });
});

/** A4：正文/身份/元信息三元素的 computed 字号、字重、颜色与包裹关系快照。 */
async function measureTypeScale(page: Page): Promise<{
  bodyFontSize: number | null;
  identityFontSize: number | null;
  identityWeight: string | null;
  metaFontSize: number | null;
  metaWeight: string | null;
  identityColor: string | null;
  metaColor: string | null;
  metaInsideIdentity: boolean;
}> {
  return page.evaluate(() => {
    const read = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      return { fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, color: cs.color };
    };
    const identity = read('[data-testid="chat-bubble-author"]');
    const meta = read('[data-testid="chat-bubble-time"]');
    return {
      bodyFontSize: read('[data-testid="chat-bubble-content"]')?.fontSize ?? null,
      identityFontSize: identity?.fontSize ?? null,
      identityWeight: identity?.fontWeight ?? null,
      metaFontSize: meta?.fontSize ?? null,
      metaWeight: meta?.fontWeight ?? null,
      identityColor: identity?.color ?? null,
      metaColor: meta?.color ?? null,
      metaInsideIdentity:
        document.querySelector(
          '[data-testid="chat-bubble-author"] [data-testid="chat-bubble-time"]'
        ) !== null,
    };
  });
}

test("A4 三级字号：正文 14px / 身份 12px·600 / 元信息 11px，时间戳为独立元信息元素", async ({
  page,
}) => {
  await mountHarness(page);
  await renderFixture(page, "body", "A4 字号层级");

  const content = page.getByTestId("chat-bubble-content");
  const author = page.getByTestId("chat-bubble-author");
  const time = page.getByTestId("chat-bubble-time");

  await expect(content).toBeVisible();
  await expect(author).toBeVisible();
  await expect(author).toHaveText(/密度/);

  const scale = await measureTypeScale(page);

  // 改动前：正文继承全局 13、身份 11/500、时间元信息缺失 → soft 断言在同一次红里全部曝光
  expect.soft(scale.bodyFontSize, "正文 computed 14px（改动前 13）").toBe(14);
  expect.soft(scale.identityFontSize, "身份 computed 12px（改动前 11）").toBe(12);
  expect.soft(scale.identityWeight, "身份 computed weight 600（改动前 500）").toBe("600");
  expect.soft(scale.metaFontSize, "元信息 computed 11px（改动前：元素不存在）").toBe(11);
  expect.soft(scale.metaWeight, "元信息 computed weight 400（不继承身份 semibold）").toBe("400");

  expect
    .soft(
      new Set([scale.bodyFontSize, scale.identityFontSize, scale.metaFontSize]).size,
      "正文/身份/元信息三级字号互不相同"
    )
    .toBe(3);

  // 时间戳从作者身份行拆出：不在 author span 内，且不与身份同时共享 fontSize+color
  expect.soft(scale.metaInsideIdentity, "时间元信息不在 author span 内").toBe(false);
  expect
    .soft(
      scale.identityFontSize === scale.metaFontSize && scale.identityColor === scale.metaColor,
      "身份与时间不得同时共享相同 fontSize 与 color"
    )
    .toBe(false);
  await expect.soft(author.locator('[data-testid="chat-bubble-time"]')).toHaveCount(0);
  await expect.soft(time).toBeVisible();
  await expect.soft(time).toHaveText(/12:00/);
  await expect.soft(time.locator('[data-testid="chat-bubble-author"]')).toHaveCount(0);
});

test("A4 守门：全局 fontSize 档位不变（md=13），消息三级字号不写入全局档", async ({ page }) => {
  await mountHarness(page);
  const tokens = await page.evaluate(() => window.__density.tokens);

  expect(tokens.fontSize).toEqual({ xs: 11, sm: 12, md: 13, lg: 15, xl: 18, xxl: 22 });
  expect(tokens.fontSize.md).toBe(13);
  expect(Object.values(tokens.fontSize)).not.toContain(14);
});

async function countLeafText(page: Page, needle: string): Promise<number> {
  return page.evaluate((n) => {
    let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode() as HTMLElement | null;
    while (node) {
      if (node.children.length === 0 && (node.textContent ?? "").includes(n)) count += 1;
      node = walker.nextNode() as HTMLElement | null;
    }
    return count;
  }, needle);
}

test("B1 共享身份栏：reasoning+tool+text 单条 agent 消息只渲染一次头像/作者/时间", async ({
  page,
}) => {
  await mountHarness(page);
  await renderFixture(page, "identity", "");

  const identity = {
    avatar: await page.getByTestId("agent-avatar").count(),
    author: await page.getByTestId("chat-bubble-author").count(),
    time: await page.getByTestId("chat-bubble-time").count(),
    authorTextLeaf: await countLeafText(page, "密度"),
    timeTextLeaf: await countLeafText(page, "12:00"),
  };
  expect(identity).toEqual({
    avatar: 1, // 改动前 3：MsgThinking / MsgTool / ChatBubble 各带一个头像
    author: 1,
    time: 1,
    authorTextLeaf: 1, // 改动前 2：thinking 头部 author + 正文身份行
    timeTextLeaf: 1, // 改动前 3：thinking / tool / 正文各带一次时间
  });

  const process = {
    thinking: await page.getByTestId("msg-thinking").count(),
    tool: await page.getByTestId("msg-tool").count(),
    bubble: await page.getByTestId("chat-bubble").count(),
    content: await page.getByTestId("chat-bubble-content").count(),
    streaming: await page.getByTestId("msg-streaming").count(),
  };
  expect(process).toEqual({ thinking: 1, tool: 1, bubble: 1, content: 1, streaming: 0 });

  await expect(page.getByTestId("chat-bubble-author")).toContainText("密度");
  await expect(page.getByTestId("chat-bubble-time")).toContainText("12:00");
  await expect(page.getByTestId("msg-thinking")).toContainText("已思考");
  await expect(page.getByTestId("msg-tool")).toContainText("identity_tool");
  await expect(page.getByTestId("chat-bubble-content")).toContainText("最终结论");
});

test("B6 未知 part：patch/step-start/step-finish/未识别 type 各渲染一个 msg-unknown-part，默认收起，已知分支不回归", async ({
  page,
}) => {
  await mountHarness(page);
  await renderFixture(page, "unknown", UNKNOWN_MARKER);

  const nodes = page.getByTestId("msg-unknown-part");
  await expect(nodes).toHaveCount(4); // 改动前 0：dispatcher 末尾 return null

  const partTypes = await nodes.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-part-type"))
  );
  expect(partTypes.slice(0, 3)).toEqual(["patch", "step-start", "step-finish"]);
  expect(partTypes[3]).toMatch(/^[A-Za-z0-9_.:-]{1,32}$/); // 未识别 type 清洗后仍是安全标签

  await expect(nodes.nth(0)).toContainText("patch");
  await expect(nodes.nth(1)).toContainText("step-start");
  await expect(nodes.nth(2)).toContainText("step-finish");

  // 默认收起：4 个折叠开关全为 aria-expanded=false，摘要与 payload 都不进 DOM
  const toggles = page.locator('[data-testid="msg-unknown-part"] button[aria-expanded]');
  await expect(toggles).toHaveCount(4);
  await expect(
    page.locator('[data-testid="msg-unknown-part"] button[aria-expanded="false"]')
  ).toHaveCount(4);
  await expect(page.getByTestId("msg-unknown-part-summary")).toHaveCount(0);
  await expect(page.getByText(UNKNOWN_MARKER)).toHaveCount(0);

  // 已知 reasoning / tool / text 分支与共享身份栏逐项不回归
  expect({
    thinking: await page.getByTestId("msg-thinking").count(),
    tool: await page.getByTestId("msg-tool").count(),
    bubble: await page.getByTestId("chat-bubble").count(),
    content: await page.getByTestId("chat-bubble-content").count(),
    streaming: await page.getByTestId("msg-streaming").count(),
    avatar: await page.getByTestId("agent-avatar").count(),
    author: await page.getByTestId("chat-bubble-author").count(),
    time: await page.getByTestId("chat-bubble-time").count(),
  }).toEqual({
    thinking: 1,
    tool: 1,
    bubble: 1,
    content: 1,
    streaming: 0,
    avatar: 1,
    author: 1,
    time: 1,
  });
  await expect(page.getByTestId("msg-thinking")).toContainText("已知推理分支");
  await expect(page.getByTestId("msg-tool")).toContainText("known_tool");
  await expect(page.getByTestId("chat-bubble-content")).toContainText("已知正文分支");
});

test("B6 展开/收起：展开显示受限 JSON 摘要，收起后摘要离开 DOM", async ({ page }) => {
  await mountHarness(page);
  await renderFixture(page, "unknown", UNKNOWN_MARKER);

  const node = page.getByTestId("msg-unknown-part").first();
  const toggle = node.locator("button[aria-expanded]");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("msg-unknown-part-summary")).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const summary = page.getByTestId("msg-unknown-part-summary");
  await expect(summary).toHaveCount(1);
  await expect(summary).toContainText('"type":"patch"');
  await expect(summary).toContainText(UNKNOWN_MARKER);
  const expandedLen = (await summary.textContent())?.length ?? 0;
  expect(expandedLen).toBeGreaterThan(0);
  expect(expandedLen).toBeLessThanOrEqual(UNKNOWN_SUMMARY_MAX);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("msg-unknown-part-summary")).toHaveCount(0);
  await expect(page.getByText(UNKNOWN_MARKER)).toHaveCount(0);
});

test("B6 超长 payload：摘要恰封顶 400 字符，第 401 字符起不进 DOM", async ({ page }) => {
  await mountHarness(page);
  expect(HUGE_PAYLOAD.length).toBeGreaterThan(UNKNOWN_SUMMARY_MAX);
  await renderFixture(page, "unknown-huge", HUGE_PAYLOAD);

  const node = page.getByTestId("msg-unknown-part");
  await expect(node).toHaveCount(1);
  await expect(node).toHaveAttribute("data-part-type", "patch");
  // 改动前无节点 → 摘要计数 0 是「节点缺失」而非「已收起」，红点由此转绿
  await expect(page.getByTestId("msg-unknown-part-summary")).toHaveCount(0);

  await node.locator("button[aria-expanded]").click();
  const summary = page.getByTestId("msg-unknown-part-summary");
  await expect(summary).toBeVisible();

  const text = (await summary.textContent()) ?? "";
  expect(text.length).toBe(UNKNOWN_SUMMARY_MAX); // 恰好封顶，不追加省略号
  expect(text).toContain(HUGE_HEAD);
  expect(text).not.toContain(HUGE_PAST_BOUND);
  await expect(page.getByText(HUGE_PAST_BOUND)).toHaveCount(0);
});

test("B6 安全标签：恶意 type 不产生标记注入，data-part-type 只含安全字符", async ({ page }) => {
  await mountHarness(page);
  await renderFixture(page, "unknown-hostile", "");

  const node = page.getByTestId("msg-unknown-part");
  await expect(node).toHaveCount(1);
  const label = await node.getAttribute("data-part-type");
  expect(label).toMatch(/^[A-Za-z0-9_.:-]{1,32}$/);
  expect(label).not.toContain("<");
  expect(label).not.toContain(">");
  expect(label).not.toContain('"');

  const dom = await page.evaluate(() => ({
    imgs: document.querySelectorAll("img").length,
    onerrorScripts: document.querySelectorAll("[onerror]").length,
    pwned: (window as unknown as { __pwned?: boolean }).__pwned ?? false,
    rawAngle: document.body.innerHTML.includes("<img src=x"),
  }));
  expect(dom).toEqual({ imgs: 0, onerrorScripts: 0, pwned: false, rawAngle: false });
});

/* ------------------------------------------------------------------ *
 * B7 用户消息状态标记 + B8 头像人名缩写（chat-ux-hierarchy-and-streaming 复选框 10）
 * ------------------------------------------------------------------ */

const USER_TEXT = "用户消息正文";

/** 渲染后 #root（不含注入的打包脚本）的 HTML/可见文本裸 id 扫描：B5/B9 契约在缩写上的复检。 */
async function expectNoRawIds(page: Page): Promise<void> {
  const dom = await page.evaluate(() => {
    const root = document.getElementById("root");
    return { html: root?.innerHTML ?? "", text: root?.innerText ?? "" };
  });
  const pattern = /(?:^|[^A-Za-z0-9_])(?:a|tmm|ta)_[0-9a-z]+/;
  expect(pattern.test(dom.html), `渲染 HTML 不含裸 id，实际命中：${dom.html.match(pattern)?.[0] ?? ""}`).toBe(false);
  expect(pattern.test(dom.text), `可见文本不含裸 id，实际命中：${dom.text.match(pattern)?.[0] ?? ""}`).toBe(false);
}

test("B7 状态矩阵：sending/sent/failed 各渲染 1 个 chat-bubble-status（data-status + 中文文案 + role=status），且在正文之外", async ({
  page,
}) => {
  await mountHarness(page);

  const cases = [
    { status: "sending", label: "发送中" },
    { status: "sent", label: "已发送" },
    { status: "failed", label: "发送失败" },
  ];
  for (const c of cases) {
    await renderFixture(page, "user-status", c.status);
    const marker = page.getByTestId("chat-bubble-status");
    await expect(marker, `status=${c.status} 应有 1 个标记`).toHaveCount(1);
    await expect(marker).toHaveAttribute("data-status", c.status);
    await expect(marker).toHaveAttribute("role", "status");
    await expect(marker).toContainText(c.label);
    await expect(page.getByTestId("chat-bubble")).toHaveCount(1);
    await expect(page.getByTestId("chat-bubble-content")).toContainText(USER_TEXT);
    await expect(
      page.locator('[data-testid="chat-bubble-content"] [data-testid="chat-bubble-status"]')
    ).toHaveCount(0);
  }
});

test("B7 缺省状态与其它状态（pending/processing/completed/未知）：不渲染任何标记", async ({ page }) => {
  await mountHarness(page);

  await renderFixture(page, "user-plain", "");
  await expect(page.getByTestId("chat-bubble")).toHaveCount(1);
  await expect(page.getByTestId("chat-bubble-status")).toHaveCount(0);

  for (const other of ["pending", "processing", "completed", "", "unknown-state"]) {
    await renderFixture(page, "user-status", other);
    await expect(page.getByTestId("chat-bubble-status"), `status=${other} 不应渲染标记`).toHaveCount(0);
  }
});

test("B7 不遮挡正文：标记在气泡下沿之外、position static，正文与气泡几何与无状态时逐像素一致", async ({
  page,
}) => {
  await mountHarness(page);

  await renderFixture(page, "user-plain", "");
  const content = page.getByTestId("chat-bubble-content");
  await expect(content).toBeVisible();
  const bubbleBody = content.locator(".."); // teal 气泡体（content 的直接父节点）
  const plainContent = await content.boundingBox();
  const plainBody = await bubbleBody.boundingBox();
  expect(plainContent).not.toBeNull();
  expect(plainBody).not.toBeNull();

  await renderFixture(page, "user-status", "failed");
  const marker = page.getByTestId("chat-bubble-status");
  await expect(marker).toBeVisible();

  const contentAfter = await content.boundingBox();
  const bodyAfter = await bubbleBody.boundingBox();
  const markerBox = await marker.boundingBox();

  expect(contentAfter).toEqual(plainContent); // 正文不位移、不改尺寸
  expect(bodyAfter).toEqual(plainBody); // 气泡体本身也不被标记撑动
  expect(markerBox).not.toBeNull();
  expect(markerBox!.y).toBeGreaterThanOrEqual(bodyAfter!.y + bodyAfter!.height); // 零交叠
  await expect(page.locator('[data-testid="chat-bubble-content"] [data-testid="chat-bubble-status"]')).toHaveCount(0);

  const style = await marker.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return { position: cs.position, fontSize: cs.fontSize };
  });
  expect(style.position).toBe("static"); // 不是定位覆盖层
  expect(style.fontSize).toBe("11px"); // 元信息级小字，而非第二段正文
});

test("B8 同角色两名成员（CJK 名）：头像缩写互不相同（张/李），可见名字与角色正确", async ({ page }) => {
  await mountHarness(page);
  await renderFixture(page, "initials-cjk", "");

  const avatars = page.getByTestId("agent-avatar");
  await expect(avatars).toHaveCount(2);
  await expect(avatars.nth(0)).toHaveText("张");
  await expect(avatars.nth(1)).toHaveText("李");
  expect(await avatars.nth(0).getAttribute("data-role")).toBe("developer");
  expect(await avatars.nth(1).getAttribute("data-role")).toBe("developer");
  expect((await avatars.nth(0).textContent()) !== (await avatars.nth(1).textContent())).toBe(true);

  const authors = page.getByTestId("chat-bubble-author");
  await expect(authors).toHaveCount(2);
  await expect(authors.nth(0)).toContainText("张伟");
  await expect(authors.nth(1)).toContainText("李静");

  await expectNoRawIds(page);
});

test("B8 同角色两名成员（拉丁名）：头像缩写取前两字母且互不相同（AL/AA）", async ({ page }) => {
  await mountHarness(page);
  await renderFixture(page, "initials-latin", "");

  const avatars = page.getByTestId("agent-avatar");
  await expect(avatars).toHaveCount(2);
  await expect(avatars.nth(0)).toHaveText("AL");
  await expect(avatars.nth(1)).toHaveText("AA");
  expect(await avatars.nth(0).getAttribute("data-role")).toBe("developer");
  expect(await avatars.nth(1).getAttribute("data-role")).toBe("developer");

  const authors = page.getByTestId("chat-bubble-author");
  await expect(authors.nth(0)).toContainText("Alice");
  await expect(authors.nth(1)).toContainText("Aaron");

  await expectNoRawIds(page);
});

test("B8 解析不到名字：回落角色字母，DOM 无裸 id，agent 消息不渲染用户状态标记", async ({ page }) => {
  await mountHarness(page);
  await renderFixture(page, "initials-fallback", "");

  const avatar = page.getByTestId("agent-avatar");
  await expect(avatar).toHaveCount(1);
  await expect(avatar).toHaveText("D"); // developer 角色字母（仅在无名字时出现）

  expect({
    author: await page.getByTestId("chat-bubble-author").count(),
    time: await page.getByTestId("chat-bubble-time").count(),
    status: await page.getByTestId("chat-bubble-status").count(),
  }).toEqual({ author: 1, time: 1, status: 0 });

  await expectNoRawIds(page);
});

test("B8 ChatBubble 接受可选 initials：显式缩写优先，未传时回落角色字母", async ({ page }) => {
  await mountHarness(page);
  await renderFixture(page, "initials-override", "");

  const avatars = page.getByTestId("agent-avatar");
  await expect(avatars).toHaveCount(2);
  await expect(avatars.nth(0)).toHaveText("ZZ"); // ChatBubble initials prop 生效
  await expect(avatars.nth(1)).toHaveText("D"); // 未传 → 角色字母

  await expectNoRawIds(page);
});

/* ------------------------------------------------------------------ *
 * B11 统一低优先级折叠 + error/aborted 可见性（chat-ux-hierarchy-and-streaming 复选框 12）
 * ------------------------------------------------------------------ */

const LONG_ATTACHMENT_NAME = `交付报告-${cjk(150, 0x4800)}`;
const ATTACH_HEAD = LONG_ATTACHMENT_NAME.slice(0, 24);
const ATTACH_TAIL = LONG_ATTACHMENT_NAME.slice(-30);

const LONG_ERROR_DETAIL = cjk(600, 0x3400);
const ERROR_HEAD = LONG_ERROR_DETAIL.slice(0, 60);
const ERROR_TAIL = LONG_ERROR_DETAIL.slice(200, 240);
const SHORT_ERROR_DETAIL = "模型繁忙 · 稍后自动重试";

const LONG_ABORTED_DETAIL = cjk(600, 0x4000);
const ABORTED_TAIL = LONG_ABORTED_DETAIL.slice(200, 240);

const LONG_SYSTEM_TEXT = cjk(300, 0x4400);
const LONG_SYSTEM_TAIL = LONG_SYSTEM_TEXT.slice(-40);

const LONG_STREAM_TEXT = cjk(300, 0x4600);
const LONG_STREAM_TAIL = LONG_STREAM_TEXT.slice(-40);

const BODY_TAIL = BODY_900.slice(-40);
const THINK_TAIL30 = THINK_AFTER_2000.slice(0, 30);
const THINK_EXPAND_HEAD = THINK_FIRST_2000.slice(-30);
const TOOL_TAIL30 = TOOL_AFTER_2000.slice(0, 30);
const TOOL_EXPAND_HEAD = TOOL_FIRST_2000.slice(-30);

test("B11 低优先级默认收起：thinking/tool/unknown/长附件初始收起且可展开", async ({ page }) => {
  await mountHarness(page);

  await renderFixture(page, "thinking", THINK_3000);
  const thinking = page.getByTestId("msg-thinking");
  await expect(thinking).toBeVisible();
  await expect(thinking.locator("button[aria-expanded]")).toHaveAttribute("aria-expanded", "false");
  await expect(thinking.getByTestId("msg-thinking-detail")).toHaveCount(0);
  await expect(thinking).not.toContainText(THINK_TAIL30);
  await thinking.locator("button[aria-expanded]").click();
  await expect(thinking.locator("button[aria-expanded]")).toHaveAttribute("aria-expanded", "true");
  await expect(thinking.getByTestId("msg-thinking-detail")).toHaveCount(1);
  await expect(thinking.getByTestId("msg-thinking-detail")).toContainText(THINK_EXPAND_HEAD);
  await expect(thinking).not.toContainText(THINK_TAIL30);

  await renderFixture(page, "tool", TOOL_3000);
  const tool = page.getByTestId("msg-tool");
  await expect(tool).toBeVisible();
  await expect(tool.locator("button[aria-expanded]")).toHaveAttribute("aria-expanded", "false");
  await expect(tool.getByTestId("msg-tool-io")).toHaveCount(0);
  await expect(tool).not.toContainText(TOOL_TAIL30);
  await tool.locator("button[aria-expanded]").click();
  await expect(tool.locator("button[aria-expanded]")).toHaveAttribute("aria-expanded", "true");
  await expect(tool.getByTestId("msg-tool-io")).toHaveCount(1);
  await expect(tool.getByTestId("msg-tool-io")).toContainText(TOOL_EXPAND_HEAD);
  await expect(tool).not.toContainText(TOOL_TAIL30);

  await renderFixture(page, "unknown-huge", HUGE_PAYLOAD);
  const unknown = page.getByTestId("msg-unknown-part");
  await expect(unknown).toHaveCount(1);
  await expect(unknown.locator("button[aria-expanded]")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("msg-unknown-part-summary")).toHaveCount(0);
  await unknown.locator("button[aria-expanded]").click();
  await expect(page.getByTestId("msg-unknown-part-summary")).toBeVisible();

  await renderFixture(page, "attachment-long", LONG_ATTACHMENT_NAME);
  const attachToggle = page.getByTestId("attachment-detail-toggle");
  await expect(attachToggle).toHaveCount(1);
  await expect(attachToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("attachment-summary")).toBeVisible();
  await expect(page.getByTestId("attachment-summary")).toContainText(ATTACH_HEAD);
  await expect(page.getByTestId("attachment-summary")).not.toContainText(ATTACH_TAIL);
  await expect(page.getByTestId("attachment-file")).toHaveCount(0);
  await attachToggle.click();
  await expect(attachToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("attachment-summary")).toHaveCount(0);
  await expect(page.getByTestId("attachment-file")).toBeVisible();
  await expect(page.getByTestId("attachment-file")).toContainText(LONG_ATTACHMENT_NAME);
  await attachToggle.click();
  await expect(attachToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("attachment-file")).toHaveCount(0);
  await expect(page.getByTestId("attachment-summary")).toBeVisible();
});

test("B11 高优先级不折叠：正文/流式正文/system 长内容全文在 DOM 且元素可见", async ({ page }) => {
  await mountHarness(page);

  await renderFixture(page, "body", BODY_900);
  const content = page.getByTestId("chat-bubble-content");
  await expect(content).toBeVisible();
  await expect(content).toContainText(BODY_TAIL);
  const bodyText = (await content.textContent()) ?? "";
  expect(bodyText).toContain(BODY_900.slice(0, 100));
  expect(bodyText).toContain(BODY_TAIL);

  await renderFixture(page, "streaming-long", LONG_STREAM_TEXT);
  const streaming = page.getByTestId("msg-streaming");
  await expect(streaming).toBeVisible();
  await expect(streaming).toContainText(LONG_STREAM_TAIL);
  await expect(streaming.locator("button[aria-expanded]")).toHaveCount(0);
  await expect(page.getByTestId("chat-bubble-toggle")).toHaveCount(0);
  const streamText = (await streaming.textContent()) ?? "";
  expect(streamText).toContain(LONG_STREAM_TEXT);

  await renderFixture(page, "system-long", LONG_SYSTEM_TEXT);
  const system = page.locator('[data-testid="chat-bubble"][data-type="system"]');
  await expect(system).toHaveCount(1);
  await expect(system).toBeVisible();
  await expect(system).toContainText(LONG_SYSTEM_TAIL);
  await expect(system.getByTestId("chat-bubble-toggle")).toHaveCount(0);
  await expect(system.getByTestId("chat-bubble-content")).toHaveCount(0);
  const systemText = (await system.textContent()) ?? "";
  expect(systemText).toContain(LONG_SYSTEM_TEXT);
  await expect(system.getByTestId("chat-bubble-time")).toHaveText("12:00");
});

test("B11 error 超长 detail：默认展开可收起，标题/状态/操作始终可见", async ({ page }) => {
  await mountHarness(page);

  await renderFixture(page, "error-long", LONG_ERROR_DETAIL);
  const err = page.getByTestId("msg-error");
  await expect(err).toBeVisible();
  await expect(err).toHaveAttribute("data-kind", "quota");
  const errToggle = page.getByTestId("msg-error-detail-toggle");
  await expect(errToggle).toHaveCount(1);
  await expect(errToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("msg-error-title")).toContainText(ERROR_HEAD);
  await expect(page.getByTestId("msg-error-detail")).toHaveCount(1);
  await expect(page.getByTestId("msg-error-detail")).toContainText(LONG_ERROR_DETAIL);
  await expect(page.getByTestId("msg-error-action")).toBeVisible();

  await errToggle.click();
  await expect(errToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("msg-error-detail")).toHaveCount(0);
  await expect(page.getByTestId("msg-error-title")).toContainText(ERROR_HEAD);
  await expect(page.getByTestId("msg-error-title")).not.toContainText(ERROR_TAIL);
  await expect(err).toContainText("insufficient_quota · 不可重试");
  await expect(page.getByTestId("msg-error-action")).toBeVisible();
  await expect(page.getByTestId("msg-error-action")).toContainText("查看升级方案");
  await errToggle.click();
  await expect(page.getByTestId("msg-error-detail")).toBeVisible();

  await renderFixture(page, "error-retry", LONG_ERROR_DETAIL);
  const retry = page.getByTestId("msg-error");
  await expect(retry).toHaveAttribute("data-kind", "retry");
  await expect(retry.getByTestId("msg-error-detail-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(retry).toContainText("RetryPart · attempt 1/3");
  await retry.getByTestId("msg-error-detail-toggle").click();
  await expect(retry.getByTestId("msg-error-detail")).toHaveCount(0);
  await expect(retry).toContainText("RetryPart · attempt 1/3");
  await expect(retry).toContainText("APIError · isRetryable · 稍后自动重试");
  await expect(retry.getByTestId("msg-error-title")).toContainText(ERROR_HEAD);
  await expect(retry.getByTestId("msg-error-action")).toHaveCount(0);

  await renderFixture(page, "error-failed", LONG_ERROR_DETAIL);
  const failed = page.getByTestId("msg-error");
  await expect(failed).toHaveAttribute("data-kind", "failed");
  await expect(failed.getByTestId("msg-error-detail-toggle")).toHaveAttribute("aria-expanded", "true");
  await failed.getByTestId("msg-error-detail-toggle").click();
  await expect(failed.getByTestId("msg-error-detail")).toHaveCount(0);
  await expect(failed).toContainText("执行失败 · 可重新发送消息触发重试");
  await expect(failed.getByTestId("msg-error-title")).toContainText(ERROR_HEAD);
});

test("B11 aborted 超长 detail：pill 与摘要始终可见，detail 默认展开可收起", async ({ page }) => {
  await mountHarness(page);

  await renderFixture(page, "aborted-long", LONG_ABORTED_DETAIL);
  const aborted = page.getByTestId("msg-aborted");
  await expect(aborted).toBeVisible();
  await expect(aborted).toContainText("已中断");
  await expect(aborted).toContainText("处理被用户中断");
  const abortToggle = page.getByTestId("msg-aborted-detail-toggle");
  await expect(abortToggle).toHaveCount(1);
  await expect(abortToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("msg-aborted-detail")).toHaveCount(1);
  await expect(page.getByTestId("msg-aborted-detail")).toContainText(LONG_ABORTED_DETAIL);

  await abortToggle.click();
  await expect(abortToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("msg-aborted-detail")).toHaveCount(0);
  await expect(aborted).toContainText("已中断");
  await expect(aborted).toContainText("处理被用户中断");
  await expect(aborted).not.toContainText(ABORTED_TAIL);

  await abortToggle.click();
  await expect(page.getByTestId("msg-aborted-detail")).toBeVisible();
  await expect(page.getByTestId("msg-aborted-detail")).toContainText(LONG_ABORTED_DETAIL);
});

test("B11 短内容不引入折叠噪音：短 error/短 aborted/短附件无开关且内容原样可见", async ({ page }) => {
  await mountHarness(page);

  await renderFixture(page, "error-short", SHORT_ERROR_DETAIL);
  await expect(page.getByTestId("msg-error")).toHaveCount(1);
  await expect(page.getByTestId("msg-error-detail-toggle")).toHaveCount(0);
  await expect(page.getByTestId("msg-error-detail")).toHaveCount(0);
  await expect(page.getByTestId("msg-error-title")).toHaveText(SHORT_ERROR_DETAIL);
  await expect(page.getByTestId("msg-error-action")).toBeVisible();

  await renderFixture(page, "aborted-short", "用户中断");
  await expect(page.getByTestId("msg-aborted")).toHaveCount(1);
  await expect(page.getByTestId("msg-aborted-detail-toggle")).toHaveCount(0);
  await expect(page.getByTestId("msg-aborted-detail")).toHaveCount(0);
  await expect(page.getByTestId("msg-aborted")).toContainText("处理被用户中断 — 用户中断");

  await renderFixture(page, "attachment-short", "report.pdf");
  await expect(page.getByTestId("attachment-detail-toggle")).toHaveCount(0);
  await expect(page.getByTestId("attachment-summary")).toHaveCount(0);
  await expect(page.getByTestId("attachment-file")).toBeVisible();
  await expect(page.getByTestId("attachment-file")).toContainText("report.pdf");
});

test("B11 折叠矩阵快照：八类内容的初始态与展开态逐行落盘", async ({ page }) => {
  await mountHarness(page);
  const rows: Array<Record<string, unknown>> = [];

  async function probe(
    name: string,
    kind: Kind,
    payload: string,
    rowSel: string,
    detailSel: string,
    toggleSel: string
  ) {
    await renderFixture(page, kind, payload);
    await expect(page.locator(rowSel).first()).toBeVisible();
    const toggle = page.locator(toggleSel).first();
    const detail = page.locator(detailSel);
    const toggleCount = await page.locator(toggleSel).count();
    const initialAria = toggleCount > 0 ? await toggle.getAttribute("aria-expanded") : null;
    const initialDetail = await detail.count();
    if (toggleCount > 0) await toggle.click();
    rows.push({
      row: name,
      rowSelector: rowSel,
      detailSelector: detailSel,
      toggleSelector: toggleSel,
      initial: { toggleCount, toggleAria: initialAria, detailCount: initialDetail },
      afterToggle: {
        toggleAria: toggleCount > 0 ? await toggle.getAttribute("aria-expanded") : null,
        detailCount: await detail.count(),
      },
    });
  }

  await probe("process(thinking)", "thinking", THINK_3000, '[data-testid="msg-thinking"]', '[data-testid="msg-thinking-detail"]', '[data-testid="msg-thinking"] button[aria-expanded]');
  await probe("tool", "tool", TOOL_3000, '[data-testid="msg-tool"]', '[data-testid="msg-tool-io"]', '[data-testid="msg-tool"] button[aria-expanded]');
  await probe("unknown", "unknown-huge", HUGE_PAYLOAD, '[data-testid="msg-unknown-part"]', '[data-testid="msg-unknown-part-summary"]', '[data-testid="msg-unknown-part"] button[aria-expanded]');
  await probe("attachment", "attachment-long", LONG_ATTACHMENT_NAME, '[data-testid="attachment-file"], [data-testid="attachment-detail-toggle"]', '[data-testid="attachment-file"]', '[data-testid="attachment-detail-toggle"]');
  await probe("error", "error-long", LONG_ERROR_DETAIL, '[data-testid="msg-error"]', '[data-testid="msg-error-detail"]', '[data-testid="msg-error-detail-toggle"]');
  await probe("aborted", "aborted-long", LONG_ABORTED_DETAIL, '[data-testid="msg-aborted"]', '[data-testid="msg-aborted-detail"]', '[data-testid="msg-aborted-detail-toggle"]');
  await probe("streaming", "streaming-long", LONG_STREAM_TEXT, '[data-testid="msg-streaming"]', '[data-testid="msg-streaming"]', '[data-testid="msg-streaming"] button[aria-expanded]');
  await probe("system", "system-long", LONG_SYSTEM_TEXT, '[data-testid="chat-bubble"][data-type="system"]', '[data-testid="chat-bubble"][data-type="system"]', '[data-testid="chat-bubble"][data-type="system"] button[aria-expanded]');
  await probe("main-body", "body", BODY_900, '[data-testid="chat-bubble-content"]', '[data-testid="chat-bubble-content"]', '[data-testid="chat-bubble-toggle"]');

  const out = path.join(
    process.cwd(),
    "..",
    ".omo",
    "evidence",
    "chat-ux-hierarchy-and-streaming",
    "task-12-collapse-matrix.json"
  );
  fs.writeFileSync(out, JSON.stringify(rows, null, 2) + "\n", "utf8");
  console.log("[B11] collapse matrix =", JSON.stringify(rows));
});

test("B11 真机交互观察：长附件/error/aborted 三态点击截图与 DOM 快照", async ({ page }) => {
  await mountHarness(page);
  const dir = path.join(process.cwd(), "..", ".omo", "evidence", "chat-ux-hierarchy-and-streaming");

  async function snap(toggleId: string, detailId: string) {
    return page.evaluate(
      ([t, d]) => {
        const read = (sel: string) => {
          const el = document.querySelector(sel);
          return el
            ? { present: true, aria: el.getAttribute("aria-expanded"), text: (el.textContent ?? "").slice(0, 80) }
            : { present: false, aria: null, text: "" };
        };
        return {
          toggle: read(`[data-testid="${t}"]`),
          detail: read(`[data-testid="${d}"]`),
          rootTextLen: (document.getElementById("root")?.textContent ?? "").length,
        };
      },
      [toggleId, detailId] as [string, string]
    );
  }

  const cases = [
    { name: "attachment", kind: "attachment-long" as Kind, payload: LONG_ATTACHMENT_NAME, toggle: "attachment-detail-toggle", detail: "attachment-file" },
    { name: "error", kind: "error-long" as Kind, payload: LONG_ERROR_DETAIL, toggle: "msg-error-detail-toggle", detail: "msg-error-detail" },
    { name: "aborted", kind: "aborted-long" as Kind, payload: LONG_ABORTED_DETAIL, toggle: "msg-aborted-detail-toggle", detail: "msg-aborted-detail" },
  ];

  const observed: Array<Record<string, unknown>> = [];
  for (const c of cases) {
    await renderFixture(page, c.kind, c.payload);
    const toggle = page.getByTestId(c.toggle);
    await expect(toggle).toHaveCount(1);
    await page.locator("#root").screenshot({ path: path.join(dir, `task-12-${c.name}-state1.png`) });
    const state1 = await snap(c.toggle, c.detail);
    await toggle.click();
    await page.locator("#root").screenshot({ path: path.join(dir, `task-12-${c.name}-state2.png`) });
    const state2 = await snap(c.toggle, c.detail);
    await toggle.click();
    observed.push({ case: c.name, state1, state2, state3: await snap(c.toggle, c.detail) });
  }

  fs.writeFileSync(path.join(dir, "task-12-observe.json"), JSON.stringify(observed, null, 2) + "\n", "utf8");
  console.log("[B11] observe =", JSON.stringify(observed));
});
