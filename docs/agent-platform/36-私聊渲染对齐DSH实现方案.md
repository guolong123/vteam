# 私聊（DM）消息渲染对齐 DSH Web · 实现方案

> 编写日期：2026-11-03 · 范围：vteam 团队会话页「私聊 Tab」的**流式输出效果**与**各类消息渲染效果**对齐 DeepSeek Harness（DSH）Web
> 关联文档：`md-docs/dsh-worker-p0-poc-report.md`（DSH 引擎接入 P0 结论）、`docs/agent-platform/10-群聊与消息机制.md`、`docs/test-cases/09-DSH引擎Worker环境测试用例.md`
> 状态：方案稿（未实施）。所有结论均带代码/实验出处。

---

## 0. 结论摘要

### 0.1 直接回答：「能不能直接用 DSH web 的代码？」

**能复用，但不能整体复用。** 准确结论分三层：

| 层 | 能否直接用 | 依据 |
|---|---|---|
| **DSH Web 整体应用**（`dsh-web-frontend/dist`，5.3 MB SPA） | ❌ 不能 | 它是 **整个 DSH Host 的前端**，自带 session 模型、cordis 插件运行时、`window.__ModuleLoader__` 加载器、`--dsw-*` 主题系统。嵌进 vteam 会得到「两套会话模型 + 两套主题 + 一层 iframe 通信」的负债，而不是复用。 |
| **DSH 渲染器注册机制**（`conversation.chat.node` keyed slot，19 个 key） | ❌ 不能 | 注册表实现在 `dsh-client-ui-renderer/lib/client.js:1290-1825`，是 **Cordis Slot 系统**（`SlotRegistry extends cordis.Service`），依赖 `@deepseek-ai/cordis ~4.0.5` + `dsh-client-ui-slots` 的声明账本/授权/卸载级联。vteam 引入 cordis 只为借用一张注册表，代价远大于收益。 |
| **DSH 渲染原子层**（`@deepseek-ai/dsh-client-ui-primitives`） | ✅ **能，且已验证** | MIT 许可、npm 公开发行、**零 cordis 耦合**（包描述原文：*"Pure React atoms for the dsh web UI: controls, icons, markdown, and JSON inspectors (zero cordis)"*）。含 DSH 的 `MarkdownText`（带**增量流式解析**）、`CodeBlock`（语言标签 / 「代码块」兜底 / 复制 / 自动换行 / Shiki 高亮 / **流式 fence 高亮**）、`DiffBlock`、`TerminalBlock`、`ReadBlock`、`SearchBlock`、`WebBlock`、`DisclosureRow`、`TextShimmer`、`JsonBlock`、`JsonTree` 等，**且所有 CSS module 原样发布**。 |

**一句话结论：复用「原子层 + 令牌层」，自建「消息层 + 映射层」。**

### 0.2 三条路径对比与选型

| 路径 | 做法 | 视觉对齐度 | 流式对齐度 | 成本 | 风险 | 结论 |
|---|---|---|---|---|---|---|
| **A. 嵌入 DSH Web** | worker 容器内跑 `dsh web`，vteam 私聊页 iframe 嵌入 + postMessage 同步 | ★★★★★ 像素级 | ★★★★★ 原生 | 中（部署 + 通信层） | 高：两套会话模型、主题不统一、iframe 沙箱、滚动/焦点/未读全要桥接 | ❌ |
| **B. 复用 primitives + 自建映射层** | npm 装 `@deepseek-ai/dsh-client-ui-primitives`，vendor `--dsw-*` 令牌，vteam 前端自写 `MsgParts` 的 DSH 风格分支 | ★★★★☆ 像素级（同一套 CSS/组件） | ★★★★☆ `MarkdownText` 原生增量解析 | 低-中 | 低：无 cordis、无 React 版本约束冲突（已验证） | ✅ **推荐** |
| **C. 自研仿 DSH** | 自己写 markdown 渲染 + 代码块 + 工具卡 | ★★☆☆☆ 靠眼睛对齐 | ★★☆☆☆ 自己实现增量解析 | 高 | 中：永远在追 | ❌ |

### 0.3 本方案已完成的三项验证（不是纸面推演）

1. **包可用性**：`@deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.5` 在 npm 公开发行，含 `lib/index.js` + `lib/**/*.css` + `lib/types/**/*.d.ts`（**类型齐全**）。MIT LICENSE（Copyright (c) 2026 DeepSeek）。
2. **React 19 兼容性**：DSH UI 包**全部 55 个都不声明 react peerDependency**（只声明 cordis），编译目标是 React 18，但 React 19 破坏性 API 扫描全部为 0 命中（`ReactDOM.render` / `defaultProps` / `propTypes` / `react-dom/server` / `unstable_*` 全无）。
3. **实机冒烟**：已在 **React 19.3.1 + Node 24** 下用 esbuild 打包 SSR 渲染通过，产出结构与参考截图一致：
   ```
   <div class="MarkdownText_markdown"><h2>实测证据</h2><ul><li>…<code>agent/assistant-stream</code></li>…</ul>
   <div class="CodeBlock_block md-code-block CodeBlock_card" data-code-wrap="true">
     <div class="CodeCard_header"><div class="CodeCard_heading"><span class="CodeCard_language">ts</span></div>
       <div class="CodeCard_actions"><button class="CodeCard_action" aria-label="自动换行" aria-pressed="true">…</button>
   ```
   且 `streaming=true` 时增量解析正常（冻结已完成块、只重解析尾部）。

> 冒烟脚本与产物见 §9 附录 A，可复现。

### 0.4 ⚠️ 最关键的发现：流式链路的**最后一跳是断的**

> **worker 从来不发送 `message.part.delta`。** `worker/src/exec/exec-server.ts:3013-3019` 的 `sendDelta()` **函数体为空**。

```ts
// worker/src/exec/exec-server.ts:3013-3019（当前 HEAD）
private async sendDelta(
  ctx: Record<string, string | undefined>,
  parts: DriverContent[],
  upstream?: UpstreamEventIdentity,
): Promise<void> {

}
```

该调用在 commit `8a82c61`（*"feat(dsh): 流式输出 + 消息排序修复"*）中被**误删**：

```diff
@@ -3013,12 +3013,7 @@ export class ExecServer {
   ): Promise<void> {
-    await this.sender.send(WORKER_EVENT_TYPES.MESSAGE_PART_DELTA, {
-      ...ctx,
-      parts,
-      status: 'streaming',
-      ...(upstream !== undefined ? { upstream } : {}),
-    });
+
   }
 }
```

传导链断在第一跳：

```
worker DSH 事件(plugin:vteam/stream-chunk) → mapToEngineEvents → handleEngineEvent('parts')
  → enqueueParts → sendDelta()  ← ★ 函数体为空，事件在此蒸发
     ⇒ server 的 handleMessagePartDelta 永不触发（不会建 processing 行、不广播 delta）
     ⇒ web 私聊页只收到 chat.message.new（终态整条）
```

**结论**：**「流式输出对齐 DSH」这件事目前连一条 delta 帧都收不到。** 必须先修这一行（§6 P0），否则渲染层的流式能力无从验证。

**好消息**：server 侧与 web 侧**已全部就绪，无需改动**：

| 环节 | 状态 |
|---|---|
| worker 驱动 → `EngineEvent{kind:'parts'}` | ✅ 已实现（`dsh-driver.ts:889-916`，token 级） |
| worker → server 的 delta 出口 | 🔴 **空实现（唯一断点）** |
| server `handleMessagePartDelta` → 建 `status=processing` 行 + 广播 delta | ✅ 已实现（`worker-event.ingress.ts:708-976`） |
| web `upsertMessage` → 原地替换 DM 列表里的 processing 行 | ✅ 已实现（`use-realtime.ts:374-379`、`:414-453`） |
| 终态收敛：终态**复用** processing 行（`update` 覆写 content + 改 sent） | ✅ 已实现（`worker-dispatcher.ts:3600-3615`） |
| 残留清扫：空 processing 行删除 / 有内容的收敛 sent | ✅ 已实现（`worker-dispatcher.ts:3655-3700`） |

---

## 1. 差距矩阵：vteam 私聊现状 ↔ DSH Web 目标

### 1.1 数据链路（现状，已确证）

```
worker（DSH/opencode 引擎）
  └─ 驱动累积成 part 快照（累积全文，非 token 增量）
       worker/src/driver/dsh-driver.ts:889-916  （DSH：plugin:vteam/stream-chunk → text/reasoning part）
       worker/src/driver/dsh-driver.ts:924-950  （DSH：assistant/stream-frame，vendor 通道）
       worker/src/driver/v2-event-map.ts:229-252 （opencode：V2StreamAccumulator）
  └─ enqueueParts → sendDelta()  ← ★★ 空实现，流式在此断掉（§0.4）
       ↓
server/src/workers/worker-event.ingress.ts:708 handleMessagePartDelta
  ├─ 定位频道（群聊触发 → 落到该成员私聊频道）
  ├─ mergePartsById（server/src/chat/message-parts.ts:433，last-write-wins + monotonicText 守卫）
  ├─ 落库（找同频道同 agent 的 status=processing 行 → update content；没有则 create）
  └─ 广播 realtime.emit(MESSAGE_PART_DELTA, {message, delta}, {type:'channel'})
       ↓
web/hooks/use-realtime.ts:374 → upsertMessage(:414) → 原地替换 DM 列表里那条 processing 行
       ↓
web/app/(main)/teams/[id]/session/page.tsx:1719 → MsgParts variant="line"
```

**关键事实**：

- 私聊**设计上**消费流式（`message.part.delta` 帧带累积快照），**但实际收不到**——因为 worker 的上送出口是空的。
- 即使恢复，前端的渲染层也没把这份能力用起来：`variant="line"` 的正文是纯文本盒，收到 delta 也只是整段替换。
- **`MarkdownText streaming` 期望的正是「到目前为止的全文」**，而 delta 帧带的就是累积全文快照 → 协议层天然契合，**恢复 `sendDelta` 后不需要三段改造**。

### 1.2 差距矩阵

| # | 维度 | vteam 私聊现状 | DSH Web 目标 | 差距 | 优先级 |
|---|---|---|---|---|---|
| **G0** | **流式通道本身** | **`sendDelta()` 空实现 → worker 从不发 delta → 私聊只收到终态整条** | token 级增量逐帧到达 | 🔴 **通道断死** | **P0（前置阻塞）** |
| G1 | **正文 Markdown** | `MsgLineBox tone="body"` → **纯文本 `<span>{text}</span>`**，无 Markdown（`msg-parts.tsx:329-369`） | `MarkdownText`：标题/列表/表格/行内代码/脚注/公式 | 🔴 **完全缺失**（私聊正文根本不是 markdown） | **P1** |
| G2 | **代码块** | `.md-render pre` 纯 CSS 深蓝块 `#0F172A`，**无语言标签 / 无复制 / 无高亮 / 无行号 / 无换行切换**（`markdown.tsx:56-66`；且私聊不经过该组件） | `CodeBlock`：语言标签（无语言时显示「代码块」）、右上角复制 + 自动换行切换、Shiki 高亮、流式 fence 增量高亮 | 🔴 完全缺失 | **P1** |
| G3 | **思考（reasoning）** | 私聊用 `MsgLineBox tone="thinking"`（灰虚线盒 + 斜体 + tail-follow 裁切） | `ReasoningRow`：`DisclosureRow` 默认折叠、首行摘要、流式 `TextShimmer` 微光、展开为完整 Markdown | 🟠 形态完全不同 | **P2** |
| G4 | **工具调用卡** | `MsgTool` 通用卡（白卡 + ⚙ 图标 + 单行 IO 摘要 + 状态胶囊），四态 running/success/failed/awaiting-input | `ToolRow` 五态（preparing/running/stopped/error/ok）+ **按工具类型分派 9 种专用视图**（read/search/web/todo/diff/bash/file-mutation/image/terminal）+ `ToolCallTree` 子调用树 | 🟠 通用卡 vs 类型化视图 | **P2** |
| G5 | **流式渲染** | 收到 delta 也只是整条替换；正文靠 tail-follow 单行裁切表达"在写" | `MarkdownText streaming` 增量解析：冻结已完成块、只重解析尾部；代码 fence 增量高亮 | 🟠 有数据无增量渲染 | **P2**（依赖 G0） |
| G6 | **消息类型覆盖** | text / reasoning / tool / error / aborted（5 种） | 另有 compaction / approval / question / plan / todo / turn-usage / model-retry / turn-error / turn-max-tokens / turn-process / command / system-prompt / context / workflow-run / goal | 🟡 大部分缺失 | **P4**（按需） |
| G7 | **中断标记** | `MsgAborted` 灰 pill「▮▮ 已中断」（✅ 已有） | `assistant/message.interrupted` 布尔 → 同语义 | 🟢 已对齐 | — |
| G8 | **设计令牌** | `--color-*`（142 个，globals.css），语义别名层只有 surface/border/mention | `--dsw-*`（~400 个，含 `--dsw-static-*` 原始色 + `--dsw-alias-*` 语义别名 + 字体阶梯 + 圆角 + 阴影 + 渐变） | 🟠 缺别名层 | **P3** |
| G9 | **用户/系统消息** | 走 `ChatBubble`，user/system **不走 Markdown**（`chat-bubble.tsx:367-371`） | 用户消息走 `UserText` 富文本 | 🟢 可接受 | P5 |
| G10 | **数学公式 / 脚注** | 无 | KaTeX / footnote | 🟡 | P4 |

### 1.3 已确认**不需要**改的部分

- **后端**：`server/src/chat/message-parts.ts`、`chat.service.ts`、`worker-event.ingress.ts`、`worker-dispatcher.ts` **本方案不改**（part 模型已够用；delta 协议已契合；终态复用 processing 行的逻辑已正确）。
  - 唯一可选跟进：补齐 ingress `toMessageDto` 的 `senderInstanceId`（`:1568`），修正多实例下未读归属 —— 与本方案解耦，可独立提。
- **群聊路径**：`variant="bubble"` 及其全部子组件 **字节不变**，`web/src/components/ui/markdown.tsx` **不改**（避免连带改群聊观感）。
- **DSH 引擎 / 驱动**：`worker/src/driver/dsh-driver.ts` 的事件映射 **不改**（token 级增量映射已正确）。只需修 `exec-server.ts` 的出口。


---

## 2. DSH Web 渲染规格（对齐基准）

### 2.1 消息模型三层

```
Core   ContentBlock（7 种）：text / reasoning / image / file / tool-call / tool-addition / tool-removal
       └─ StreamChunk（流式增量）：block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish
Session SessionEvent（60+ 种）：turn/start|end · step/start|end · user/message · assistant/message · tool/call · tool/result
       · approval/asked|decided|policy · command/run|done · compaction/* · todo/write · llm/retry · team/*
Web    ConversationNode（19 个 keyed slot）
       └─ AssistantMarkdown 把 ContentBlock 投影成 5 种 block kind：text / reasoning / image / tool-call / other
```

**关键**：DSH 的 Web 层最终只渲染 5 种 block。vteam 私聊当前渲染 5 种 part（text/reasoning/tool/error/aborted）—— **基数相当，缺的是呈现形态**。

### 2.2 正文（`AssistantMarkdown` → `MarkdownText`）

DSH 的消息正文合成（`dsh-client-ui-chat/lib/client.js` `AssistantMarkdown`）：

| block kind | 渲染 |
|---|---|
| `text` | `<MarkdownText text streaming labels fileMentions pathImages />` |
| `reasoning` | `<ProcessReasoning><ReasoningRow text running /></ProcessReasoning>` |
| `image` | 图片槽（连续 image 合并成组） |
| `tool-call` | **不在此处渲染**（被提升为独立 ConversationNode，见 2.4） |
| 其它 | `<JsonBlock label="未知块" payload />` |

`MarkdownText` 契约（`dsh-client-ui-primitives/lib/types/markdown/MarkdownText.d.ts`）：

```ts
{ text: string; streaming?: boolean; labels: MarkdownLabels;
  fileMentions?: MarkdownFileMentions; pathImages?: MarkdownPathImages;
  variant?: "body" | "compact" }
```

`MarkdownLabels` 契约（`lib/types/markdown/render.d.ts:23-36`）：

```ts
interface MarkdownCodeLabels { copyLabel: string; copiedLabel: string; toolbarLabels?: CodeToolbarLabels }
interface CodeToolbarLabels  { codeLabel: string; wrapLabel: string; unwrapLabel: string }
interface MarkdownLabels     { code: MarkdownCodeLabels; footnotes: string }
```

DSH 的注入方式（`dsh-client-ui-chat/lib/client.js` `markdown-labels.js`）：

```js
{ code: { copyLabel: t("copy"), copiedLabel: t("copied"),
          toolbarLabels: { codeLabel: t("codeBlock.title"),
                           wrapLabel: t("codeBlock.wrap"), unwrapLabel: t("codeBlock.unwrap") } },
  footnotes: t("markdown.footnotes") }
```

对应 DSH `common` 命名空间词典（`dsh-client-locale/lib/client.js`，MIT）：

| key | 中文 | 英文 |
|---|---|---|
| `copy` | 复制 | Copy |
| `copied` | 复制成功 | Copied |
| `codeBlock.title` | **代码块** | Code block |
| `codeBlock.wrap` | 自动换行 | Wrap lines |
| `codeBlock.unwrap` | 取消自动换行 | Do not wrap lines |
| `markdown.footnotes` | 脚注 | Footnotes |

> 参考截图中代码块左上角显示的「代码块」，即 `codeBlock.title` —— **当围栏没有语言标注时的兜底标题**（DSH `CodeToolbar` 源码：`F_(lang) ? lang : labels.codeLabel`）。

### 2.3 Markdown 栈

| 层 | DSH | vteam 现状 |
|---|---|---|
| Parser | `micromark` + `mdast-util-from-markdown` | `react-markdown`（remark 管线） |
| 扩展 | GFM + math + footnote + 自研 CJK 友好强调 | 仅 GFM |
| 高亮 | **Shiki**（`css-variables` 主题，59 种懒加载语言包） | 无 |
| 公式 | **KaTeX**（`throwOnError`，字体随包） | 无 |
| 渲染 | 自研 mdast→React（`switch` over nodes，非 react-markdown） | react-markdown |
| 流式 | 增量 parser：冻结已完成块为缓存 React element，只重解析尾部 | 无 |
| 安全 | raw HTML 渲染为字面文本、协议白名单 | react-markdown 默认（同等安全） |

> **`MarkdownText` 的安全模型与 react-markdown 同级**（DSH 文档明确："raw HTML renders as literal text (no HTML enters the DOM)"）。切换不会降低 vteam 的 XSS 防护。

### 2.4 工具调用卡

**状态机（5 态）**（`dsh-client-ui-tool/lib/client.js:298-303`）：

```js
const done  = "kind" in block;
const state = !done ? (block.phase === "preparing" ? "preparing" : "running")
                    : (block.error?.code === "interrupted" ? "stopped"
                       : block.isError ? "error" : "ok");
```

**渲染形态**：可折叠 `DisclosureRow`（`expandOnRowClick: true`），折叠行 = 图标 + 标题 + 摘要 + `ExitCodeBadge` + diff 统计 `+N -N`；**preparing 态不可展开**。

**展开后按优先级分派 9 种视图**（`:1697-1796`）：

```
askQuestion → terminal → diff → read → image → search → web → details → code → 通用 IO
```

**工具名 → 变体映射**（`:92-107`，节选）：

```js
{ bash:'bash', pwsh:'bash', read:'read', read_image:'read', web_fetch:'read',
  web_search:'search', grep:'search', glob:'search', write:'write', edit:'edit',
  run_code:'code', cordis_package_inspect:'read', ... }
```

另有 46 个工具专属标题 key（`todo_write` / `ask_user_question` / `spawn_teammate` / `team_task_create` / `wait_agent` / `send_message` / `job_kill` …）。

> vteam 工具名空间与 DSH 不同（vteam 是 MCP 风格 `<server>_<tool>`，如 `vteam_task_context`），**变体映射表需要按 vteam 工具名重写一份**，不能照抄。

### 2.5 思考（Reasoning）

- 默认**折叠**（`useDisclosure` 初始 `expandedVersion = null`）。
- 折叠态显示**首行摘要**（settled）或**最新完整段落首行**（streaming），摘要去掉 `**` 标记。
- 流式时摘要用 `TextShimmer` 微光动画；CSS 固定高度一行（`contain: size layout; height: 24px`）。
- 展开态渲染完整 Markdown（次级排版 `variant="compact"`）。
- `reasoningText()` 会剥掉模型输出的 `<signature>…</signature>` 前缀。

### 2.6 设计令牌 `--dsw-*`

- **权威源**：`@deepseek-ai/dsh-client-ui-theme` 的 `lib/client.js` 内联 CSS 字符串（`base_css_default` / `design_platform_css_default` / `shiki_css_default` / `scrollbar_css_default` / `focus_css_default` 等），约 **400 个 token**，三层结构：
  - `--dsw-static-*`：原始色板（neutral / blue / green / red / amber / deepseek / 深浅两套）
  - `--dsw-alias-*`：语义别名（`bg-base` / `border-l1..l4` / `label-primary|secondary|tertiary|caption` / `markdown-code-block` / `markdown-inline-code` / `interactive-bg-hover` / `state-error-primary` …）
  - `--dsw-font-*` / `--dsw-radius-*` / `--dsw-shadow-*` / `--dsw-elevation-*` / `--dsw-linear-gradient-*`：字体阶梯 / 圆角 / 阴影 / 层级 / 渐变
- **暗色**：DSH 用 `[data-ds-dark-theme]` 属性选择器（外加 `prefers-color-scheme`）；vteam 用 `.dark` class → 需要一层桥接。
- primitives 的 CSS 只消费 `--dsw-*`，**改 token 即可整体换肤**，无需改组件。

---

## 3. 复用可行性矩阵

### 3.1 包级评估

| 包 | 依赖 | 与 cordis 耦合 | 复用建议 |
|---|---|---|---|
| `@deepseek-ai/dsh-client-ui-primitives` | 纯 React + shiki/katex/micromark/diff/anser/clsx/simple-icons + 3 个 dsh util 包 | **零** | ✅ **直接装、直接用** |
| `@deepseek-ai/dsh-client-store` | zustand + immer | 零 | ✅ 仅作 primitives 传递依赖 |
| `@deepseek-ai/dsh-util-code-language` / `dsh-util-workspace-path` | 无 | 零 | ✅ 仅作传递依赖 |
| `@deepseek-ai/dsh-client-ui-theme` | cordis（仅 `installThemeStyles(ctx)` 注入 CSS） | 中 | 🟡 **不装**，改为 vendor 其 CSS 字符串 |
| `@deepseek-ai/dsh-client-locale` | cordis | 低 | 🟡 **不装**，直接抄 `common` 词典（MIT） |
| `@deepseek-ai/dsh-client-ui-tool` | cordis + primitives + slots | 高 | 🟡 **只借鉴 models 层**（纯函数），React 层在 vteam 重写 |
| `@deepseek-ai/dsh-client-ui-chat` | cordis + 10+ 内部包 | 极高 | 🔴 **只借鉴模型**（block 投影 / 状态机） |
| `@deepseek-ai/dsh-client-ui-conversation` | cordis + slot 运行时 | 极高 | 🔴 不可复用 |
| `@deepseek-ai/dsh-client-ui-renderer` | cordis + slots | 极高 | 🔴 不可复用 |
| `@deepseek-ai/dsh-web-frontend` | 无（静态产物） | 零 | 🔴 不采用（见 §0.2 路径 A） |

### 3.2 primitives 的运行时依赖（vteam 需要显式安装）

`@deepseek-ai/dsh-client-ui-primitives` 的 `dependencies` 只有 `@deepseek-ai/schemastery`；下列是它**运行时 import 但未声明**的包，必须由 vteam 侧补齐（已在冒烟中实测确认）：

```
react  react-dom  react/jsx-runtime
shiki  @shikijs/langs  (shiki/core, shiki/engine/javascript)
katex  anser  clsx  diff  simple-icons
micromark-core-commonmark  micromark-util-{character,classify-character,symbol,types,sanitize-uri}
micromark-factory-space  micromark-extension-{gfm,math}
mdast-util-{from-markdown,gfm,math}
@deepseek-ai/dsh-client-store  @deepseek-ai/dsh-util-code-language  @deepseek-ai/dsh-util-workspace-path
zustand  immer            (dsh-client-store 的依赖)
```

> ⚠️ **不装 `shiki` 的全量语言包**：`@shikijs/langs` 整包约 3.1 MB。DSH 自己用的是「按需懒加载语言分块」。vteam 侧建议：
> - 方案 a：只装 `@shikijs/langs/json` / `typescript` / `shellscript`（primitives 只 import 这三个）+ 其余语言按需动态 `import()`；
> - 方案 b：先用 `shiki/core` 的 `createHighlighterCoreSync` + 少量内置 grammar，够用再扩。

### 3.3 许可与合规

- primitives / theme / locale / tool / chat 等全部包 LICENSE **逐字节相同**，MIT，Copyright (c) 2026 DeepSeek。复用仅需保留版权声明 + MIT 文本。
- 字体：`Montserrat-OFL.txt`（SIL OFL）——若 vendor `brand-font.css` 需一并保留 OFL 声明。
- 无 BSL / source-available / 附加限制条款。

### 3.4 引擎兼容性（opencode ↔ DSH）

vteam 支持两个 worker 引擎（`worker/src/engine/index.ts:43`）：

```ts
export const SUPPORTED_ENGINES: readonly WorkerEngineKind[] = ['opencode', 'dsh'];
export const DEFAULT_WORKER_ENGINE: WorkerEngineKind = 'opencode';   // ← 缺省仍是 opencode
```

**本方案的绝大多数部分与引擎无关。** 分层看：

| 方案部分 | 是否引擎相关 | 依据 |
|---|---|---|
| **P1/P2/P3 渲染层**（正文 Markdown / 代码块 / 思考行 / 工具卡 / `--dsw-*` 令牌） | ❌ **完全无关** | 两个引擎产出的 part 类型集合**完全相同**：`text` / `reasoning` / `tool` / `step-finish`（opencode：`v2-event-map.ts:595,626,650`；DSH：`dsh-driver.ts:1002,1010` 等）。服务端 `normalizeParts()`（`server/src/chat/message-parts.ts:36`）把两者归一成同一模型，前端只认 `content.parts[]` |
| **P0 流式修复** | ❌ **无关，且一次修好两个引擎** | `sendDelta` 是 exec-server 的**公共出口**，三条路径全部汇聚到它（见下表） |
| **P4 补齐 DSH 特有消息类型** | 🟡 **部分相关** | compaction / llm-retry / command/run / turn-usage 等是 **DSH 特有事件**，opencode 无对应来源；`todo` / `plan` 两边都有工具形态，可共用 |

**三条流式路径的汇聚点**（都调用被清空的 `sendDelta`）：

| 引擎 | 路径 | 汇聚点 |
|---|---|---|
| opencode | 轮询路 `onPoll` → `enqueueDelta` | `exec-server.ts:2654` → `sendDelta` |
| opencode | SSE 事件路 `handleV2Event`（`outcome.type === MESSAGE_PART_DELTA`） | `exec-server.ts:2991` → `enqueueParts` → `:2672` → `sendDelta` |
| DSH | 引擎事件路 `handleEngineEvent` `case 'parts'` | `exec-server.ts:2908` → `enqueueParts` → `:2672` → `sendDelta` |

> ⚠️ **推论**：commit `8a82c61` 删掉那 6 行，**同时打断了 opencode 的流式**（不只是 DSH）。恢复后两个引擎一起恢复。

**两个需要单独处理的边角**：

| 边角 | opencode | DSH | 处理 |
|---|---|---|---|
| **流式/终态 part id 口径** | 一致 ✅ 流式 `${messageID}:text` = 终态 `${messageID}:text`（`v2-event-map.ts:482`） | 不一致 ⚠️ 流式 `${turn}:${step}:${index}`（`dsh-driver.ts:899`）≠ 终态 `${messageID}:text`（`:1002,1010`） | 靠服务端「终态整体覆写 processing 行 content」收敛（`worker-dispatcher.ts:3600-3615`），不会双渲染；但 DSH 侧必须端到端实测（P0-3） |
| **增量累积缓存清理** | ✅ `V2StreamAccumulator` 已有「断线重连必须清空」逻辑 | ⚠️ `liveTexts` Map **从不清理**（`dsh-driver.ts:238`）→ worker 重启 + session resume 后 turn 计数回退会**拼接陈旧文本** | P0-2 明确修（只影响 DSH） |
| **工具名 → 视图映射表** | opencode 自带工具名 | DSH 自带工具名（bash/read/write/edit/grep/glob/web_fetch…） | vteam 自己的 MCP 工具（`vteam_*`）两边共用；映射表覆盖不到的名字**落到通用卡**，不会崩 |

---

## 4. 目标架构

```
web/
├── app/globals.css                      # 追加 DSH 令牌层（vendor 的 --dsw-* + [data-ds-dark-theme] 桥接）
├── src/theme/dsw-tokens.ts              # DSH 令牌 → vteam 语义的映射常量（若需要覆盖）
└── src/components/chat/dsh/             # ★ 新增：DSH 风格私聊渲染层
    ├── dsh-labels.ts                    # DSH locale 词典（copy/copied/codeBlock.*/markdown.footnotes）
    ├── dsh-markdown.tsx                 # MarkdownText 封装（labels 注入 + streaming 开关）
    ├── dsh-reasoning.tsx                # ReasoningRow 等价物（DisclosureRow + 首行摘要 + shimmer）
    ├── dsh-tool-card.tsx                # 工具卡（5 态 + 按 vteam 工具名分派视图）
    ├── dsh-message.tsx                  # 一条 agent 消息的合成（身份栏 + 过程 + 正文）
    └── dsh-parts-adapter.ts             # vteam PartShape → DSH block kind 映射 + 状态推导
```

**分层职责**：

| 层 | 内容 | 来源 |
|---|---|---|
| L0 依赖层 | npm 依赖（primitives + shiki/katex/micromark…） | 新增 `web/package.json` |
| L1 令牌层 | `--dsw-*` CSS（vendor 自 theme 包）+ 暗色桥接 | `web/app/globals.css` |
| L2 原子层 | `MarkdownText` / `CodeBlock` / `DisclosureRow` / `TextShimmer` / `JsonBlock` / `DiffBlock` … | npm primitives（不改一行） |
| L3 消息层 | vteam 自写 `dsh-*.tsx`（reasoning 行、工具卡、消息合成） | 借鉴 DSH chat/tool 的模型 |
| L4 映射层 | `PartShape → block kind` + 状态推导 + 流式判定 | vteam 自写 |
| L5 页面层 | `session/page.tsx` 把 `variant="line"` 换成 `variant="dsh"` | 改 1 处分支 |

---

## 5. 改造清单（文件级）

### 5.1 L0 — 依赖（新增）

`web/package.json`：

```jsonc
"dependencies": {
  "@deepseek-ai/dsh-client-ui-primitives": "0.2.1-rc.5",   // 锁版本，勿用 latest（latest 指向 0.0.1-rc.1）
  "@deepseek-ai/dsh-client-store": "0.2.1-rc.5",            // primitives 传递依赖
  "@deepseek-ai/dsh-util-code-language": "0.2.1-rc.5",
  "@deepseek-ai/dsh-util-workspace-path": "0.2.1-rc.5",
  "shiki": "^4.4.3", "@shikijs/langs": "^4.4.3",
  "katex": "^0.18.7", "anser": "^2.3.5", "clsx": "^2.0.0", "diff": "^9.0.0", "simple-icons": "16.31.0",
  "micromark-core-commonmark": "^2.0.3", "micromark-util-character": "^2.1.1",
  "micromark-util-classify-character": "^2.0.1", "micromark-util-symbol": "^2.0.1",
  "micromark-util-types": "^2.0.2", "micromark-util-sanitize-uri": "^2.0.1",
  "micromark-factory-space": "^2.0.1", "micromark-extension-gfm": "^3.0.0", "micromark-extension-math": "^3.1.0",
  "mdast-util-from-markdown": "^2.0.3", "mdast-util-gfm": "^3.1.0", "mdast-util-math": "^3.0.0",
  "zustand": "^5.0.14",   // 已有，版本对齐
  "immer": "^10"
}
```

⚠️ `katex` 需要在 `web/app/layout.tsx` 或 `web/app/globals.css` 引入 `katex/dist/katex.min.css`（primitives 的 `MarkdownText.d.ts` 自带 `import 'katex/dist/katex.min.css'`，Next.js 需确认该 CSS 能被处理——**若报「全局 CSS 只能从 layout 引入」则需改为在 layout 显式 import**）。

### 5.2 L1 — 令牌层

`web/app/globals.css`：

1. 追加 DSH 令牌（vendor 自 `@deepseek-ai/dsh-client-ui-theme` 的内联 CSS 字符串，MIT，**保留 MIT 声明**）。
2. 暗色桥接：vteam 用 `.dark` class，DSH 用 `[data-ds-dark-theme]`：
   ```css
   .dark { /* 复制 DSH 暗色 token 值 */ }
   /* 或：给私聊容器加 data-ds-dark-theme 属性，复用 DSH 原生暗色块 */
   ```
   **推荐后者**（`:root` 之外的暗色块原样可用，改动面最小）。
3. 追加 DSH 的 shiki 令牌（`shiki_css_default`，`--shiki-*`）。

`web/src/theme/tokens.ts`：新增 `dsw` 别名导出，把 vteam 语义映射到 `--dsw-*`（如 `dsw.codeBlockBg = "var(--dsw-alias-markdown-code-block)"`），供 vteam 自写组件使用。

### 5.3 L2/L3/L4 — 新增私聊渲染层（`web/src/components/chat/dsh/`）

| 文件 | 职责 | 依据 |
|---|---|---|
| `dsh-labels.ts` | DSH `common` 词典（复制/复制成功/代码块/自动换行/取消自动换行/脚注） | `dsh-client-locale/lib/client.js` zh/en 词典 |
| `dsh-markdown.tsx` | `<DshMarkdown text streaming />` → 包 `MarkdownText`，注入 labels；`streaming` 由调用方给 | `MarkdownText.d.ts` |
| `dsh-reasoning.tsx` | 思考行：默认折叠、首行摘要、流式 shimmer、展开渲染 `MarkdownText variant="compact"` | `ReasoningRow.js` + `DisclosureRow` |
| `dsh-tool-card.tsx` | 工具卡：`preparing/running/stopped/error/ok` 五态 + 折叠 + 按 vteam 工具名分派（read/search/web/diff/terminal/generic） | `ToolRow.js` + `TOOL_VARIANTS`（映射表按 vteam 工具名重写） |
| `dsh-parts-adapter.ts` | `PartShape[] → DshBlock[]`（text/reasoning/tool/error/aborted）+ 每块的渲染态推导（流式/终态/失败/等待输入） | vteam `PartShape` + DSH `toAssistantBlock` |
| `dsh-message.tsx` | 一条 agent 消息：身份栏 + 按原顺序渲染 blocks（**不做"过程在上、正文置底"的 bubble 式重排**，保持 DSH 的时间顺序观感） | `AssistantMarkdown` |

### 5.4 L5 — 页面接入

`web/app/(main)/teams/[id]/session/page.tsx`：

| 位置 | 改动 |
|---|---|
| `:1719` `variant={isGroupTab ? "bubble" : "line"}` | → `variant={isGroupTab ? "bubble" : "dsh"}` |
| `:1396-1406` parts 过滤 | 私聊保持全量；新增：跳过 `synthetic`（注入上下文）在 dsh 分支内由 adapter 处理 |
| 容器 `:1648` `data-testid="chat-message-list"` | 外层加 `data-ds-dark-theme` 桥接属性（若采用） |

`web/src/components/chat/msg-parts.tsx`：

| 改动 | 说明 |
|---|---|
| `variant` 类型 | `"bubble" \| "line" \| "dsh"`；`"line"` 保留（**不删**，老 e2e 与历史回归仍引用；新分支独立） |
| 新增 dsh 分支 | 委托给 `dsh-message.tsx`；保留 `aborted` 独占分支与 `secretAwaiting` 语义 |
| 复用现有 | `toolView()` 的空卡兜底 / 终态收敛 / `secret_command → awaiting-input` 判定逻辑**下沉到 adapter**，避免两份实现 |

### 5.5 Worker 侧（P0 —— 唯一改 worker 的地方）

| 文件 | 改动 |
|---|---|
| `worker/src/exec/exec-server.ts:3013-3019` | 恢复 `sendDelta` 的发送调用（commit `8a82c61` 删除的 6 行）：<br>`await this.sender.send(WORKER_EVENT_TYPES.MESSAGE_PART_DELTA, { ...ctx, parts, status:'streaming', ...(upstream !== undefined ? { upstream } : {}) })` |
| `worker/src/driver/dsh-driver.ts:238` | `liveTexts` Map 在 `turn/end` 时清空（或改键为含 sessionId 的轮次口径），避免 resume 后拼接陈旧文本 |

> 其余 worker 代码（驱动事件映射 `mapToEngineEvents`、DSH 引擎、vendor 脚本）**不改** —— token 级增量映射本身是正确的，断的是出口。

### 5.6 不改的部分（明确边界）

- **后端**：`server/src/chat/message-parts.ts`、`chat.service.ts`、`worker-event.ingress.ts`、`worker-dispatcher.ts` **本方案不改**（part 模型已够用；delta 协议已契合；终态复用 processing 行的逻辑已正确）。
  - 唯一可选跟进：补齐 ingress `toMessageDto` 的 `senderInstanceId`（`:1568`），修正多实例下未读归属 —— 与本方案解耦，可独立提。
- **群聊路径**：`variant="bubble"` 及其全部子组件 **字节不变**，`web/src/components/ui/markdown.tsx` **不改**（避免连带改群聊观感）。
- **DSH 引擎 / 驱动映射**：`worker/src/driver/dsh-driver.ts` 的 `mapToEngineEvents` **不改**。

---

## 6. 分阶段实施

> 阶段顺序原则：**先通流式通道（G0）→ 再做渲染对齐（G1/G2）→ 再补消息类型与流式渲染（G3/G4/G5）→ 最后做主题统一与扩类型。**
> G0 是硬前置：不修它，P2 的流式渲染无法验证。

### P0 — 打通流式通道（硬前置，1 行代码）

**目标**：worker 开始真正发送 `message.part.delta`，私聊页能在消息成型前看到增量。

| 步骤 | 内容 | 产出 |
|---|---|---|
| P0-1 | 恢复 `worker/src/exec/exec-server.ts:3013-3019` 的 `sendDelta` 发送调用 | 恢复 commit `8a82c61` 删除的 6 行 |
| P0-2 | 修 `liveTexts` 泄漏：`dsh-driver.ts:238` 的 `Map` **从不清理**，键为 `${turn}:${step}:${index}`；worker 重启 + DSH 会话 resume 后 turn 计数可能回退 → 增量会**拼接上一轮的陈旧文本**。修复：在 `turn/end` 分支清空该 Map（或键改为含 sessionId 且带轮次重置） | 驱动 1 处 |
| P0-3 | 核对 part id 口径：流式 id = `${turn}:${step}:${index}`，终态 id = `${messageID}:text` / `${messageID}:reasoning`。终态是**整体覆写 processing 行的 content**（`worker-dispatcher.ts:3600-3615`），所以不会双渲染；但需实测确认终态 content 覆盖的是**同一行**、前端不出现两条消息 | 实测用例 |
| P0-4 | 端到端验证：DSH 私聊发一条消息，观察 `message.part.delta` 是否逐帧到达、processing 行是否被正确终态化为 sent | 手工 + e2e |

**验收**：私聊页在模型还在写的时候就能看到正文逐段出现（此时先以纯文本盒呈现即可，P2 再升级为 Markdown 增量渲染）。

**回滚**：恢复 `sendDelta` 是**纯增量**改动——回滚后行为回到当前（终态整条），无数据兼容问题。

### P1 — 正文与代码块对齐（价值最高、风险最低）

**目标**：私聊正文出现与 DSH 一致的 Markdown 排版 + 代码块（语言标签 / 复制 / 高亮 / 换行切换）。

| 步骤 | 内容 | 产出 |
|---|---|---|
| P1-1 | 装 L0 依赖 + vendor L1 令牌 | `web/package.json`、`web/app/globals.css` |
| P1-2 | 新增 `dsh-labels.ts` + `dsh-markdown.tsx`，跑通 `MarkdownText`（非流式） | 新组件 |
| P1-3 | 新增 `dsh-parts-adapter.ts`（先只映射 text + reasoning） | 映射层 |
| P1-4 | `msg-parts.tsx` 增 `variant="dsh"` 分支，正文走 `MarkdownText` | 私聊正文可渲染 Markdown |
| P1-5 | e2e：`web/e2e/session-unification.spec.ts:838-866` 的私聊强断言需**新增** dsh 变体断言（旧 line 断言保留） | 测试同步 |

**验收**：私聊正文出现 H2/H3/列表/表格/行内代码；代码块显示语言标签、右上角复制按钮（点击提示「复制成功」）、自动换行切换、Shiki 着色。

### P2 — 消息类型与流式渲染

| 步骤 | 内容 |
|---|---|
| P2-1 | `dsh-reasoning.tsx`：思考行（默认折叠 + 首行摘要 + 流式 shimmer） |
| P2-2 | `dsh-tool-card.tsx`：工具卡五态 + 折叠 + vteam 工具名 → 视图映射 |
| P2-3 | `MarkdownText streaming` 接入：delta 帧到达时以 `streaming=true` 渲染，终态转 `streaming=false`（依赖 P0） |
| P2-4 | 状态收敛：`aborted` / `error` / `awaiting-input` 在 dsh 变体下的呈现 |

**验收**：流式过程中正文**逐段增量出现**（已冻结的块不重排、不闪烁）；工具卡状态实时切换；思考行在流式时显示 shimmer。

### P3 — 令牌与主题统一

| 步骤 | 内容 |
|---|---|
| P3-1 | 暗色桥接（`.dark` ↔ `[data-ds-dark-theme]`）双向验证 |
| P3-2 | vteam 自写组件（身份栏 / 输入框 / 滚动条）token 化到 `--dsw-*` |
| P3-3 | 确认 `MarkdownText` 在 vteam 亮/暗两套下的对比度（`--dsw-alias-label-primary` vs `--dsw-alias-markdown-code-block`） |

### P4 — 补齐 DSH 缺失的消息类型（按需排期）

优先级（来自 DSH `conversation.chat.node` 的 19 个 key 与 vteam 现状比对）：

| 类型 | 触发 | 价值 | 备注 |
|---|---|---|---|
| compaction（上下文压缩） | 长会话 | 🔴 高 | vteam 目前无感知 |
| turn-usage / stats pills | 每轮结束 | 🟡 中 | DSH 有 `TurnUsagePanel` + `StatsPills` |
| turn-error / turn-max-tokens | 异常轮次 | 🟡 中 | vteam 现有 `MsgError` 覆盖大半 |
| todo / plan | `todo_write` 工具 | 🟡 中 | vteam 有任务体系，可映射 |
| approval / question | 引擎请求 | 🔴 高 | vteam 已有 `QuestionModal`，走独立链路，不进消息流 |
| system-prompt / context | — | 🟢 低 | |

> 建议：P4 **不与 P1/P2 同批**。先把「对齐渲染」做完，再评估「补消息类型」。

### P5 —（可选）群聊同样对齐

若要「整个会话页都像 DSH」，群聊需另立改造（P1 相同、P2/P3 可复用），工作量约 ×1.5。本方案默认**只做私聊**。


---

## 7. 验收标准

### 7.1 视觉对齐（与参考截图逐项核对）

| 检查项 | DSH 基准 | vteam 目标 |
|---|---|---|
| H2/H3 标题 | 粗体、紧凑上下间距 | ✅ 同（同一组件） |
| 无序列表 | `-` 缩进列表 | ✅ 同 |
| 行内代码 | 等宽 chip | ✅ 同 |
| 代码块标题栏左 | 语言名（无语言 → **「代码块」**） | ✅ 同 |
| 代码块标题栏右 | 复制按钮 + 自动换行切换（图标按钮 + tooltip） | ✅ 同 |
| 代码块正文 | Shiki 着色 + 等宽字体 | ✅ 同 |
| 表格 | 边框表格，超宽横向滚动 | ✅ 同 |
| 思考 | 默认折叠、首行摘要 | ✅ 同 |
| 工具卡 | 折叠行 + 状态 | ✅ 同（视图按 vteam 工具名重映射） |

### 7.2 流式验收

- **P0 通道验收**：私聊发一条消息 → server 收到 `message.part.delta` 帧 → DB 出现 `status=processing` 的 agent 消息行 → 终态后该行**被原地更新**为 `status=sent`（**不新增第二条消息**）。
- delta 帧到达 → 正文在 **1 帧内**可见增量（不等终态）。
- 流式中已完成的 markdown 块**不重排、不闪烁**（`MarkdownText streaming` 的冻结语义）。
- 终态（`chat.message.new`）到达后，全量重渲染结果与流式末帧**视觉一致**（无跳变）。
- 断线重连：流式内容不丢（现状靠 30s 轮询兜底，见 §8 风险 R3）。

### 7.3 回归验收

- 群聊 Tab（`variant="bubble"`）**零变化**：既有 e2e 全绿。
- 私聊旧 `variant="line"` 保留可用（先不删），老断言可继续跑。
- `web/e2e/reference/testids.ts` 新增 dsh 变体 testid（如 `msg-dsh-body` / `msg-dsh-reasoning` / `msg-dsh-tool`）。

---

## 8. 风险与回滚

| # | 风险 | 影响 | 缓解 | 回滚 |
|---|---|---|---|---|
| **R0** | **恢复 `sendDelta` 后流式/终态内容不一致**：流式 part id = `${turn}:${step}:${index}`，终态 part id = `${messageID}:text` | 若终态 content 未覆盖同一行 → 前端出现**两条消息**（流式一条 + 终态一条） | 终态路径**已实现**「复用 processing 行 + 整体覆写 content」（`worker-dispatcher.ts:3600-3615`），残留清扫也排除主行（`:3655-3700`）→ 不会双渲染。但**必须端到端实测**（P0-3/P0-4） | 还原 `sendDelta` 空实现 |
| **R0b** | **`liveTexts` Map 永不清理**（`dsh-driver.ts:238`） | worker 重启 + DSH 会话 resume 后 turn 计数回退 → 增量文本**拼接上一轮陈旧内容** | P0-2 明确修：`turn/end` 清空或改键口径 | — |
| **R0c** | **delta 帧带全量快照**（每帧一条完整 message） | 高频流式下 SSE 带宽与 server 写放大 | 现状设计如此（`realtime.service.ts:126` 已因 26GB 事故把 delta 排除出落库表）。恢复后需观测 QPS 与带宽 | 保留节流 `DELTA_PERSIST_INTERVAL_MS`（ingress `:834-852`） |
| R1 | **primitives 依赖链未声明完整**（import 了但没在 dependencies 里） | 安装后构建失败 | 已实测列出全部 17 个，见 §3.2 | 移除依赖，回退 `variant="line"` |
| R2 | **React 18→19 行为差异**（虽无明显破坏性 API） | 偶发渲染差异 | 已在 React 19.3.1 实机冒烟通过；P1 阶段用 e2e 覆盖 | 同上 |
| R3 | **`message.part.delta` 不落 `realtime_events`**（`realtime.service.ts:126`） | SSE 断线期间流式内容补不回（靠 30s 轮询） | 与本方案解耦；如需根治另立议题（持久化 delta 或改走 `session/follow`） | — |
| R4 | **shiki 语言包体积** | 前端包体膨胀 3.1 MB | 只装 primitives 实际 import 的 3 个语言，其余按需动态 import | 退回无高亮（`CodeBlock` 的 `lang` 传 undefined → 纯文本代码块） |
| R5 | **`katex` CSS 全局引入约束**（Next.js 全局 CSS 限制） | 构建报错 | 在 `web/app/layout.tsx` 显式 `import "katex/dist/katex.min.css"` | 暂不启用公式（math 扩展可拆开） |
| R6 | **e2e 强断言**（`session-unification.spec.ts:838-866` 断言私聊 `msg-line-box` 数量/顺序、且 `chat-bubble`/`msg-thinking`/`msg-streaming` 计数为 0） | 改造后必红 | P1-5 同步测试：保留 line 断言 + 新增 dsh 断言 | 保留 line 分支 → 一行回退 |
| R7 | **DSH 版本漂移**（npm `latest` 指向 `0.0.1-rc.1`，真实可用版本是 `0.2.1-rc.5` / `0.2.2-alpha.3`） | 误装旧版 | **锁死精确版本** + `npm view` 校验 dist-tag | — |
| R8 | **视觉与 vteam 群聊割裂** | 用户觉得两个 Tab 不像同一个产品 | P3 阶段把 vteam 自有组件也 token 化到 `--dsw-*` | — |
| R9 | **DSH 私有包不可用**（若上游撤下或改 license） | 复用路径失效 | primitives 已锁定 `0.2.1-rc.5`；vendor 一份到 `web/vendor/` 可离线兜底 | 回退自研（§0.2 路径 C） |


---

## 9. 附录

### 附录 A — React 19 兼容性冒烟（可复现）

```bash
mkdir -p /tmp/dsw-smoke && cd /tmp/dsw-smoke
cat > package.json <<'EOF'
{"name":"dsw-smoke","private":true,"type":"module","dependencies":{
  "react":"^19.2.0","react-dom":"^19.2.0",
  "@deepseek-ai/dsh-client-ui-primitives":"0.2.1-rc.5"}}
EOF
npm install
npm install shiki @shikijs/langs katex anser clsx diff simple-icons \
  micromark-core-commonmark micromark-util-character micromark-util-classify-character \
  micromark-util-symbol micromark-util-types micromark-util-sanitize-uri micromark-factory-space \
  micromark-extension-gfm micromark-extension-math mdast-util-from-markdown mdast-util-gfm mdast-util-math \
  @deepseek-ai/dsh-client-store @deepseek-ai/dsh-util-code-language @deepseek-ai/dsh-util-workspace-path \
  zustand immer
# entry.tsx：renderToStaticMarkup(<MarkdownText text={md} labels={labels} streaming />)
npx esbuild entry.tsx --bundle --platform=node --format=cjs --jsx=automatic \
  --loader:.css=empty --outfile=out.cjs && node out.cjs
```

预期输出（节选）：

```
<div class="MarkdownText_markdown"><h2>实测证据</h2><ul><li>…</li></ul>
<div class="CodeBlock_block md-code-block CodeBlock_card" data-code-wrap="true">
  <div class="CodeCard_header"><div class="CodeCard_heading"><span class="CodeCard_language">ts</span></div>
    <div class="CodeCard_actions"><button class="CodeCard_action" aria-label="自动换行" aria-pressed="true">
```

### 附录 B — 关键代码索引

**DSH 侧（解压产物 `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai/`）**

| 用途 | 位置 |
|---|---|
| Core ContentBlock / StreamChunk 类型 | `dsh-llm/lib/typert.host.js:316-632` |
| Session 事件类型全集 | `dsh-api-session-controller/lib/typert.host.js:2799-2811` |
| Slot 注册表（cordis 耦合证据） | `dsh-client-ui-renderer/lib/client.js:1290-1825` |
| Chat node 注册（19 个 key） | `dsh-client-ui-chat/lib/client.js:7199-7319` |
| AssistantMarkdown 合成 | `dsh-client-ui-chat/lib/client.js`（`AssistantMarkdown.js` region） |
| ReasoningRow | `dsh-client-ui-chat/lib/client.js:6150-6250` |
| markdownLabels 注入 | `dsh-client-ui-chat/lib/client.js:4249-4269` |
| 工具状态机 / 变体表 | `dsh-client-ui-tool/lib/client.js:298-303` / `:92-165` |
| 工具折叠行 + 9 视图分派 | `dsh-client-ui-tool/lib/client.js:1573-1853` / `:1697-1796` |
| DSH locale 词典（代码块等文案） | `dsh-client-locale/lib/client.js`（zh / en 词典） |
| `--dsw-*` 令牌 CSS | `dsh-client-ui-theme/lib/client.js`（`base_css_default` / `design_platform_css_default` / `shiki_css_default`） |
| DSH Web 静态产物 | `dsh-web-frontend/dist/`（5.3 MB） |

**npm 包（可直接安装）**

| 包 | 版本 | 用途 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-primitives` | `0.2.1-rc.5` | 渲染原子（MarkdownText / CodeBlock / DisclosureRow / …） |
| `@deepseek-ai/dsh-client-store` | `0.2.1-rc.5` | primitives 传递依赖 |
| `@deepseek-ai/dsh-util-code-language` | `0.2.1-rc.5` | primitives 传递依赖 |
| `@deepseek-ai/dsh-util-workspace-path` | `0.2.1-rc.5` | primitives 传递依赖 |

**vteam 侧（改造点）**

| 文件 | 行 | 现状 |
|---|---|---|
| `web/app/(main)/teams/[id]/session/page.tsx` | `:1719` | `variant={isGroupTab ? "bubble" : "line"}` ← 切换点 |
| 同上 | `:1396-1406` | 私聊 parts 不过滤（全量） |
| 同上 | `:908-924` | `onMessagePartDelta`（滚动 + 补拉 + 未读） |
| `web/src/components/chat/msg-parts.tsx` | `:329-369` | line 分支（纯文本盒）← 主改造点 |
| 同上 | `:58-77` | `PartShape` 定义 |
| 同上 | `:225-270` | `toolView()`（空卡兜底 / 终态收敛 / awaiting-input）← 下沉到 adapter |
| `web/src/components/chat/msg-line-box.tsx` | `:45-121` | 私聊单行盒（保留，不动） |
| `web/src/components/ui/markdown.tsx` | `:14-103` | react-markdown 封装（群聊共用，**本方案不改**） |
| `web/hooks/use-realtime.ts` | `:374-379` / `:414-453` | delta 消费 + upsert（本方案不改，**前提是 worker 先发 delta**） |
| `worker/src/exec/exec-server.ts` | `:3013-3019` | 🔴 **`sendDelta` 空实现 → 流式断点（P0 必修）** |
| `worker/src/driver/dsh-driver.ts` | `:238` / `:889-916` | `liveTexts` Map 永不清理（P0-2 必修）；流式事件映射本身正确（不改） |
| `web/e2e/session-unification.spec.ts` | `:838-866` | 私聊形态强断言 ← 必须同步 |
| `server/src/chat/message-parts.ts` | `:36` / `:433` / `:524` | part 归一 / 合并 / 群聊裁剪（**不改**） |
| `server/src/workers/worker-event.ingress.ts` | `:708` / `:962` / `:1568` | delta 落库 + 广播（**不改**；`:1568` 可选补 `senderInstanceId`） |
| `server/src/chat/worker-dispatcher.ts` | `:3600-3615` / `:3655-3700` | 终态复用 processing 行 + 残留清扫（**不改**，P0-3 需实测验证） |

### 附录 C — DSH 与 vteam 消息类型对照（Web 层）

| DSH block kind | vteam part type | 备注 |
|---|---|---|
| `text` | `text` | 语义一致；DSH 走 MarkdownText，vteam 当前走纯文本盒 |
| `reasoning` | `reasoning` / `thinking` | `thinking` 是 vteam 的别名，需归一 |
| `tool-call` | `tool` | vteam 带 `state{status,input,output,error}`，DSH 带 `callId/name/args/content/isError` |
| （其它） | `error` | DSH 的 error 是 `tool/result.error` 或 `turn/end reason=error` |
| （其它） | `aborted` | DSH 是 `assistant/message.interrupted` 布尔 / `turn/end reason=aborted` |
| `image` | —（附件走 `attachmentUrl` 三字段） | vteam 用独立附件模型，不走 block |
| （丢弃） | `step-start` / `step-finish` / `snapshot` / `patch` | vteam 内部片段，两端都不渲染 |

### 附录 D — DSH 事件协议速查（对齐 streaming 语义用）

DSH 事件分三层，vteam 只用得着第一层：

| 层 | 事件 | 是否落盘 | vteam 是否用 |
|---|---|---|---|
| **durable 会话事件**（63 种，`dsh-session/lib/types/known-event-types.js:21-84`） | `turn/start\|end` · `step/start\|end` · `assistant/message` · `tool/call` · `tool/result` · `approval/*` · `command/*` · `compaction/*` · `todo/write` · `llm/retry` · `team/*` | ✅ | ✅ 主力通道 |
| **runtime 事件**（进程内、scope 绑定） | `agent/assistant-stream`（token 帧 start/chunk/end） | ❌ | ❌ **不可跨进程**，vteam 改走 durable 桥 |
| **客户端 transient** | `assistant/live-chunk` | ❌ | ❌ **仅存在于 DSH 浏览器内存**（`dsh-api-session-controller/lib/types/client/sessions/assistant-stream.js:109-125` 客户端合成，`seq` 是小数） |

**为什么 DSH web 能逐字、vteam 不能**（结论）：

```
agent-loop 进程 ──emit──▶ agent/assistant-stream（进程内 + scope 绑定，不落盘）
     │
     ├─(host 同进程)─▶ api-session-controller follow() 订阅 → dense frame
     │                  → WS /api/remote.mux → 浏览器 ClientAssistantStream 合成 assistant/live-chunk
     │
     └─(SDK 另一个进程)─▶ ✗ 不落盘、✗ 无协议通道
                            ⇒ vteam 必须自建 durable 桥：
                              vendor 在 agent-loop 的 live.push(chunk) 处写
                              appendPluginRecord(session, "plugin:vteam/stream-chunk", {turn, step, chunk})
                              ⇒ 复用 session/event 通道送达 SDK 客户端
```

**vteam 的桥接点**（已就绪）：

| 位置 | 内容 |
|---|---|
| `worker/scripts/vendor-sdk-server.mjs:329-368` | 在 agent-loop 的 `live.push(chunk)` 处注入 hook，写 `plugin:vteam/stream-chunk` durable record |
| `worker/scripts/vendor-sdk-server.mjs:242-256` | SDK server 订阅 `agent/assistant-stream` → 转 `assistant/stream-frame` 通知 |
| `worker/src/driver/dsh-driver.ts:889-916` | 消费 `plugin:vteam/stream-chunk` → 映射为 `text`/`reasoning` part（累积全文快照，键 `${turn}:${step}:${index}`） |
| `worker/src/driver/dsh-driver.ts:924-950` | 消费 `assistant/stream-frame`（同上） |

**DSH 的流式帧类型**（`dsh-llm/lib/typert.host.js:572`）：

```ts
type StreamChunk =
  | { type:'block-start';  index; blockType }
  | { type:'text-delta';   index; text }
  | { type:'reasoning-delta'; index; text }
  | { type:'tool-call-delta'; index; id; name?; argumentsDelta }
  | { type:'block-end';    index; block }
  | { type:'usage'; usage }
  | { type:'finish'; reason; replayState? }
```

> vteam 的准入语义是**「单调全文」**（同 `part.id` 拒绝文本变短，见 `worker/src/driver/prompt-await.ts:1402 admitSsePart`），故驱动内维护 `liveTexts` 把 delta 累积成全文再上送 —— **这正好是 `MarkdownText streaming` 需要的输入形态**。

**结论**：vteam 应对齐的是**语义**（token 增量 → 全文快照 → 单调准入），而不是事件名；`assistant/live-chunk` 是 DSH 浏览器客户端的私有合成物，不可复用。

---

## 10. 待确认事项

1. **P0 优先**：是否先单独提一个「恢复流式通道」的修复（1 行 + `liveTexts` 清理），与渲染对齐解耦？→ **建议先做**，它是「流式对齐 DSH」的前提，且可独立验证、独立回滚。
2. **暗色桥接方式**：私聊容器挂 `data-ds-dark-theme` 属性（改动最小），还是在 `.dark` 下复制一套 DSH 暗色 token？→ 建议前者。
3. **`variant="line"` 是否保留**：建议保留（老 e2e + 历史回归），待新分支稳定后再评估下线。
4. **是否同步对齐群聊**：本方案只改私聊。若要「整个会话页都像 DSH」，需另立一份群聊改造（P1 相同、P2/P3 可复用），工作量约 ×1.5。
5. **公式（KaTeX）是否首期启用**：启用需引入 katex CSS + 字体（约 300 KB），建议 P4 再开。
6. **vteam 工具名 → DSH 视图映射表**由谁提供：需要一份 vteam MCP 工具清单（`<server>_<tool>` 命名空间）才能定稿 `dsh-tool-card.tsx` 的分派表。
7. **是否 vendor 一份 primitives 到 `web/vendor/`**：npm 依赖当前可用（`0.2.1-rc.5`），但上游撤包/改 license 的风险存在（R9）。→ 建议首期直接用 npm，P1 稳定后再决定是否 vendor。

---

## 11. 建议的下一步

| # | 动作 | 产出 |
|---|---|---|
| 1 | 提「恢复流式通道」修复（`sendDelta` + `liveTexts` 清理） | PR #1（worker 侧，独立可验证） |
| 2 | 端到端验证流式：DSH 私聊发消息 → 观察 delta 帧与 processing 行 | 验证记录 + e2e 用例 |
| 3 | 装 DSH primitives + vendor `--dsw-*` 令牌，建 `web/src/components/chat/dsh/` 骨架 | PR #2（前端依赖与骨架） |
| 4 | 实现 `dsh-markdown.tsx` + `dsh-parts-adapter.ts` + `variant="dsh"` 正文分支 | PR #3（G1/G2 达成） |
| 5 | 实现 `dsh-reasoning.tsx` / `dsh-tool-card.tsx` + `streaming` 接入 | PR #4（G3/G4/G5 达成） |


---

## 12. 实施记录（2026-11-03，本轮已落地）

> 本节省略设计推演，只记录**实际改了什么、验证结果如何、还剩什么**。

### 12.1 已落地的改动

**worker 侧（流式通道，两个引擎共用）**

| 文件 | 改动 |
|---|---|
| `worker/src/exec/exec-server.ts:3013-3025` | 恢复 `sendDelta()` 的 `sender.send(MESSAGE_PART_DELTA, {...})`（commit `8a82c61` 误删的发送调用），并补注释说明它是三条流式路径的唯一出口 |
| `worker/src/driver/dsh-driver.ts` | ① 新增 `livePartId` / `accumulateChunkPart` / `clearLiveTexts` 三方法，把三处重复的增量累积逻辑收拢；② part id 由 `${turn}:${step}:${index}` 改为 **`${sessionId}:${turn}:${step}:${index}`**（修跨会话串扰）；③ `case 'turn/end'` 里调 `clearLiveTexts(sessionId)`（修 resume 后拼接陈旧文本） |
| `worker/src/driver/engine-events.spec.ts` | 三条 `turn/end` 用例的事件形状由扁平的 `{ kind }` 改为 DSH 真实形状 `{ turn, reason: { kind } }`（`0476387` 改实现后测试没跟上；其中 error 那条此前是**误绿**） |

**web 侧（DSH 风格渲染层）**

| 文件 | 说明 |
|---|---|
| `web/package.json` / `package-lock.json` | 新增 `@deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.5` + 3 个 dsh util 包 + shiki/katex/micromark/mdast 等 17 个运行时依赖（**锁死精确版本**，`latest` 指向 0.0.1-rc.1 不可用） |
| `web/src/theme/dsh/dsw-tokens.css`（新增，21.9 KB） | vendor DSH 的 `--dsw-*` 令牌（`base` + `design_platform` + `shiki` 三块）。**刻意不引入** scrollbar / focus / corner-shape 三块（带全局选择器，会连带改掉群聊页的滚动条与焦点环） |
| `web/app/layout.tsx` | 全局引入上面的令牌 CSS（只有变量定义，无组件样式） |
| `web/src/components/chat/dsh/dsh-labels.ts`（新增） | DSH `common` 词典（复制/复制成功/**代码块**/自动换行/取消自动换行/脚注）+ memo 化的 `MarkdownLabels` |
| `web/src/components/chat/dsh/dsh-markdown.tsx`（新增） | 封装 `MarkdownText`（DSH 正文渲染器） |
| `web/src/components/chat/dsh/dsh-reasoning.tsx`（新增） | 思考折叠行（`DisclosureRow` + `IconThinkOutlineRegular` + `TextShimmer`） |
| `web/src/components/chat/dsh/dsh-tool-card.tsx`（新增） | 工具折叠卡（状态点 + 工具标题 + 摘要，展开出输入/输出） |
| `web/src/components/chat/dsh/dsh-parts-adapter.ts`（新增） | `PartShape[] → DshBlock[]` 纯函数映射（去重 / synthetic 剔除 / 空卡兜底 / 终态收敛 / awaiting-input 派生，口径与老分支一致） |
| `web/src/components/chat/dsh/dsh-message.tsx`（新增） | 一条 agent 消息的时间线合成（身份栏 + 按序块 + 附件） |
| `web/src/components/chat/dsh/index.ts`（新增） | 统一出口 |
| `web/src/components/chat/msg-parts.tsx` | `variant` 扩为 `"bubble" \| "line" \| "dsh"`；dsh 分支整条委托 `DshMessage`；**`line` 分支原样保留**（回退只需改一行）；导出 4 个 tool-view 纯函数供 adapter 复用（行为不变） |
| `web/app/(main)/teams/[id]/session/page.tsx:1719` | 私聊 `variant` 由 `"line"` 改为 `"dsh"` |
| `web/e2e/session-unification.spec.ts:838-860` | 私聊形态断言由 `msg-line-box` 改为 `dsh-reasoning` / `dsh-tool` / `dsh-body` |
| `web/e2e/reference/testids.ts` | 补登 12 个 `dsh-*` testid |

**群聊路径**：`variant="bubble"` 及其全部子组件、`src/components/ui/markdown.tsx` **零改动**。

### 12.2 验证结果

| 验证项 | 结果 |
|---|---|
| `worker` 类型检查 `tsc --noEmit` | ✅ 通过 |
| `worker` 测试基线 | ✅ **36 红 → 16 红**（`exec-server.spec.ts` 23 → 5；`engine-events.spec.ts` 3 → 1） |
| 剩余红灯性质 | 已用「回滚改动后重跑」证实**均为既有独立问题**，非本轮引入（见 §12.3） |
| `web` 类型检查 `tsc --noEmit` | ✅ 通过（唯一报错在未改动的 `e2e-trial/dsh-trial.spec.ts`，属既有问题） |
| `web` 生产构建 `next build` | ✅ 通过（`/teams/[id]/session` 272 kB / First Load 633 kB） |
| `web` ESLint（新目录 + 改动文件） | ✅ 0 error（1 条既有 warning：`MsgUnknownPart` 未被引用） |
| **组件 SSR 渲染验证** | ✅ **16/16 结构断言通过**（见下表） |
| **真机视觉验证**（真实历史数据） | ✅ 7 条消息全部走 DSH 渲染层，`msg-line-box`=0，代码块/标题/列表/表格齐全（§12.2b） |
| **端到端流式验证**（重建 worker 镜像后实机发消息） | ✅ **STREAMING OBSERVED**；本轮 agent 消息仅 1 条（无双渲染）（§12.2c） |

SSR 渲染验证覆盖（`react-dom/server` 实机渲染 `DshMessage`，非快照模拟）：

| 断言 | 结果 |
|---|---|
| DSH 正文容器 `MarkdownText_markdown` | ✅ |
| `## 实测证据` → `<h2>` | ✅ |
| 无序列表 / 表格 / 行内代码 chip | ✅ |
| 代码块卡片容器 `CodeBlock_block` | ✅ |
| 代码块语言标签 `CodeCard_language` | ✅ |
| **无语言围栏回落到「代码块」**（截图同款） | ✅ |
| **自动换行按钮** `aria-label="自动换行"` | ✅ |
| **复制按钮**（「复制」文案） | ✅ |
| 思考行 `dsh-reasoning` + 摘要去 `**` | ✅ |
| 工具卡 `dsh-tool` + 标题映射 | ✅ |
| 消息根 / 身份栏 | ✅ |
| 流式模式（`streaming=true`，文本逐步变长） | ✅ 三档截断均正确渲染 |

### 12.2b 真机视觉验证（本地 next start + 试用环境真实数据）

把 web 以生产构建产物起在 `localhost:3100`，`API_PROXY_TARGET` 指向已在跑的
`vteam-trial-server`（`localhost:13000`），用试用环境的 JWT secret 签一个管理员
token 后，用 Playwright 打开「vteam开发团队 → 私聊: 开发者-1」实测：

| 探针 | 实测值 |
|---|---|
| `dsh-message`（新渲染层的消息根） | 7 |
| `dsh-body` / `dsh-markdown`（DSH 正文） | 8 / 8 |
| `dsh-reasoning`（折叠思考行） | 27 |
| `msg-line-box`（旧单行盒） | **0**（已彻底不再出现） |
| `CodeCard_heading`（代码块标题栏） | 2 |
| `button[aria-label="自动换行"]` | 2 |
| `dsh-markdown h2` / `table` / `li` / `code` | 8 / 1 / 9 / 13 |

**实抓的代码块 DOM**（Next 已对 CSS module 做哈希，映射与样式均生效）：

```html
<div class="CodeBlock_block__9pMg2 md-code-block CodeBlock_card__MSLv_" data-code-wrap="true">
  <div class="CodeBlock_bannerWrap__TFdSz">
    <div class="CodeCard_header__5BUn9" data-code-block-banner="true">
      <div class="CodeCard_heading__ykXnn"><span class="CodeCard_language__BkwmH">python</span></div>
      <div class="CodeCard_actions__qt92X">
        <button aria-label="自动换行" aria-pressed="true">…</button>
        <button aria-label="复制">…</button>
      </div>
    </div>
```

视觉结论（截图逐项比对参考图）：代码块左侧显示语言名（无语言时回落「代码块」）、
右侧「自动换行 + 复制」两个图标按钮、Shiki 语法着色；标题为真 `<h2>`、行内代码渲染成
等宽 chip、列表与表格正常排版 —— 与 DSH Web 的结构和观感一致。**私聊正文此前是纯文本，
现在已是完整的 Markdown 文档级排版。**

### 12.2c 端到端流式验证（重建 worker 镜像后实机跑通）

把 `worker/Dockerfile.dsh` 用修好的源码重建为 `vteam-worker:dsh`（旧镜像打了
`vteam-worker:dsh-backup` 便于回滚），重建试用栈的 worker 容器并重置团队会话，
然后用 Playwright 在真实私聊里发一条「要求输出二级标题 + python 代码块 + 三项列表」的消息，
每 250ms 采样一次 DOM。

**采样结果**：

| 指标 | 实测值 |
|---|---|
| 采样次数 | 53 |
| 正文文本**不同长度**出现次数 | 5 |
| 增量增长步数 | 3 |
| `data-streaming="true"` 的采样数 | 4 |
| 结论 | **STREAMING OBSERVED** |

**中途截图（流式进行中）** 显示的内容序列：

1. 思考行出现且带 shimmer（`思考 The user asks for a simple answer…`）；
2. `验证` 以 `<h2>` 出现；
3. 段落正文逐段出现；
4. **代码块已出现 header（`python` + 自动换行 + 复制），但内容此刻只有 `print`**
   —— 这是代码围栏**边写边高亮**的直接证据；最终变为 `print("hello")`；
5. 三项列表随后补全。

**数据库落点（同一回合）**：

```
本轮 agent 消息数: 1
  m_0000000294  status=sent  parts=['reasoning','text','step-finish']
```

- **只有一条** agent 消息 ⇒ 流式行与终态行是**同一行**（`processing` → `sent` 原地收敛），
  即 §8 的 R0 风险（双消息）**未发生**；
- `status=processing` 的行只可能由 `worker-event.ingress.handleMessagePartDelta` 创建
  （`worker-event.ingress.ts:932`）⇒ 观察到 `data-streaming=true` 就证明
  **worker → server → web 三段链路真的通了**；
- 该行最终 `status=sent` ⇒ 终态收敛路径（`worker-dispatcher.ts:3600-3615`）正常复用同一行。

> 说明：前一次未重置会话的尝试报 `[dsh-rpc] SDK server is not initialized（code=-32603）`
> —— 那是 worker 重启后 server 侧仍持旧 DSH session id、`session/resume` 失败导致的
> **既有 resume 兜底问题**（`dsh-driver` 的日志`resume 未成功但会话可能仍存在`后继续用旧会话），
> 与本轮改动无关；重置会话后即恢复正常。

### 12.3 已知剩余问题（**非本轮引入**，均已用「回滚改动后重跑」证实）

| Suite | 剩余 | 根因 | 建议 |
|---|---|---|---|
| `exec/exec-server.spec.ts` | 5 | ① `createSession` 现签名为 `(model, agentPreset, agentSystem)`，测试仍断言 1 参数（commit `993cd0d` 遗留）② 3 条「在飞直送」用例期望「零事件」，但实现已加「防空转回退常规执行」会发 `session.updated`/`agent.status` | 单独一个「测试补债」PR |
| `exec/exec-server.sessions.spec.ts` | 2 | 同 ① `createSession` 签名漂移 | 同上 |
| `driver/engine-events.spec.ts` | 1 | persona env 用例改的是构造时已快照的 `options.env`，改不动（DSH persona 走 env 注入 + 重启） | 同上或按设计重写 |
| `driver/v2-driver.spec.ts` | 9 | 「对**真** opencode v2 server 的契约测试」——需本机跑真实 opencode serve | 环境性，需 CI 起真实运行时 |

### 12.4 尚未做的（下一轮）

| 项 | 状态 |
|---|---|
| 端到端手测 | ✅ **DSH 引擎已跑通**（§12.2c，流式 + 无重复消息）；⬜ opencode 引擎待跑（需重建 opencode worker 镜像，改动同一出口，风险低） |
| 工具卡的 9 种专用视图（read/search/web/diff/terminal…） | ⬜ 当前是通用卡（等价 DSH `GenericToolCard` fallback）；需先拿到 vteam MCP 工具清单 |
| 群聊页也切 DSH 风格 | ⬜ 未做（本方案默认只改私聊） |
| 包体优化：shiki/katex 改动态 import | ⬜ 当前 `/teams/[id]/session` 272 kB，可接受；若要压，把 `MarkdownText` 与 `CodeBlock` 走 `next/dynamic` |
| P4 的 DSH 特有消息类型（compaction / turn-usage / llm-retry…） | ⬜ 另排期（且 opencode 引擎无对应来源） |
