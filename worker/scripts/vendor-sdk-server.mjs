#!/usr/bin/env node
/**
 * vendor-sdk-server.mjs —— 给 DSH 的 SDK JSON-RPC server 补两个方法（P5）。
 *
 * 背景（P0 实测）：已发布的 `@deepseek-ai/dsh-sdk-jsonrpc-server` 只实现 7 个方法
 * （initialize / session/prompt / session/resume / session/wait /
 * session/working-directory/{get,set} / shutdown），**没有 cancel 与 steer**。
 * 而 vteam 需要：
 *
 * - `session/cancel`：GUI 停止按钮同款语义 → `agent.cancel({kind:'user'},{keepInbox:true})`
 *   （P0 已实测：turn/end kind=aborted + 进程存活 + 部分输出保留 + 会话可继续）
 * - `session/steer`：在途注入 → `agent.steer(message)`（类型见
 *   `dsh-agent/lib/types/runtime-types.d.ts:221`）
 *
 * ## 为什么用构建期文本注入而不是 fork 包
 *
 * SDK server 的编译产物是**单个 lib/index.js**（约 600 行），方法分派是一个封闭 switch。
 * fork 整个包会带来升级期的 diff 维护负担；而在 switch 里插两个 case 是**最小改动面**，
 * 且可用幂等 + 结构断言保证升级后不会静默失配。
 *
 * 本脚本的契约：
 * - **幂等**：已打过补丁则跳过（重复运行安全）
 * - **可验证**：patch 后断言两处 case 都存在，否则**非零退出**（构建失败）
 * - **可诊断**：找不到锚点时打印实际文件内容摘要（升级后定位成本低）
 *
 * 用法（镜像构建期）：
 *   node scripts/vendor-sdk-server.mjs [sdkServerDir]
 * 缺省目录：从全局 npm root 解析 `@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server`
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/** 解析 SDK server 的 lib/index.js 路径。 */
function resolveTargetPath(explicitDir) {
  if (explicitDir !== undefined) {
    return join(explicitDir, 'lib', 'index.js');
  }
  // 从全局 npm root 找 dsh 安装内的 SDK server
  let npmRoot;
  try {
    npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(`无法解析全局 npm root：${err.message}`);
  }
  const candidate = join(
    npmRoot,
    '@deepseek-ai',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-sdk-jsonrpc-server',
  );
  if (!existsSync(candidate)) {
    throw new Error(`未找到 SDK server 目录：${candidate}`);
  }
  return join(candidate, 'lib', 'index.js');
}

/** 要注入的两个 case（**保持与既有 switch 风格一致的 tab 缩进**）。 */
const CANCEL_CASE = `
\t\t\tcase "session/cancel": {
\t\t\t\t// vteam P5 vendor：GUI 停止按钮同款语义。
\t\t\t\t// keepInbox=true 保留排队/steering 输入（与 GUI 的停止按钮一致）；
\t\t\t\t// 部分输出以 interrupted 语义落库，进程存活、会话可继续。
\t\t\t\tconst sid = params?.sessionId;
\t\t\t\tconst rec = typeof sid === "string" ? this.sessions.get(sid) : undefined;
\t\t\t\tif (!rec) throw new Error(\`session not found: \${String(sid)}\`);
\t\t\t\trec.handle.agent.cancel({ kind: "user" }, { keepInbox: true });
\t\t\t\treturn { accepted: true };
\t\t\t}`;

/**
 * steer 的 message 形状：AgentHandle 的 `steer(message: UserMessage)`。
 * UserMessage 需要 `{ id, content, source }`（与 DSH 内部 createUserMessage 同形）。
 * vteam 只传纯文本 → 组装为单个 text block。
 */
/**
 * `session/create`：**创建会话时绑定 agent preset**（P6）。
 *
 * 为什么需要这个扩展：DSH 的 preset 选择有严格时机——`agentPresets.select()`
 * 要求会话**尚未开始首个 turn**（`agent-preset/locked`），而 SDK 协议本来没有
 * per-session 创建方法（`session/prompt` 会隐式建会话，那时已经晚了）。
 *
 * 所以必须"先建会话 + 立刻选 preset"，两者在同一个 case 里完成：
 * 1. 用 `getOrCreateSession` 建（或复用）会话
 * 2. 若 registry 存在且该会话**还没跑过 turn**，调 `agentPresets.select(agent, presetId)`
 * 3. registry 不存在（未配置 roster）时退化为警告（不阻断，保持向后兼容）
 *
 * 语义对齐 vteam：一个成员实例 = 一个 Agent = 一个 preset；
 * 团队里 PM/开发/测试并发时各用自己的 preset，**共享同一个运行时进程**。
 */
const CREATE_CASE = `
\t\t\tcase "session/create": {
\t\t\t\tconst sid = params?.sessionId;
\t\t\t\tif (typeof sid !== "string" || sid.length === 0) throw new TypeError("session/create requires a non-empty sessionId");
\t\t\t\tconst preset = typeof params?.agentPreset === "string" && params.agentPreset.length > 0 ? params.agentPreset : undefined;
\t\t\t\tconst presetPlugins = Array.isArray(params?.agentPresetPlugins) ? params.agentPresetPlugins : undefined;
\t\t\t\t// **建会话前**登记 preset：让 createSession 的 meta.agentPreset 生效，
\t\t\t\t// 避免事后再 select() 的 recompose 丢掉 provider/model（实测踩坑）
\t\t\t\tthis.__vteamPreset = preset;
\t\t\t\tlet rec;
\t\t\t\ttry {
\t\t\t\t\trec = await this.getOrCreateSession(sid);
\t\t\t\t} finally {
\t\t\t\t\tthis.__vteamPreset = undefined;
\t\t\t\t}
\t\t\t\tif (preset !== undefined) {
\t\t\t\t\tconst registry = this.ctx.get("agentPresets");
\t\t\t\t\tif (registry === undefined) {
\t\t\t\t\t\tconsole.warn(\`[vendor] session/create: agentPreset=\${preset} 但未挂载 preset registry → 忽略\`);
\t\t\t\t\t} else {
\t\t\t\t\t\tif (presetPlugins !== undefined && presetPlugins.length > 0) {
\t\t\t\t\t\t\ttry {
\t\t\t\t\t\t\t\tawait registry.register({ id: preset, name: preset, plugins: presetPlugins });
\t\t\t\t\t\t\t} catch (err) {
\t\t\t\t\t\t\t\tif (!/Duplicate agent preset/i.test(err.message)) {
\t\t\t\t\t\t\t\t\tconsole.warn(\`[vendor] session/create: 运行时注册 preset \${preset} 失败：\${err.message}\`);
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t\t// **不调用 select()**：meta.agentPreset 已在建会话时完成绑定。
\t\t\t\t\t\t// 实测：对已绑定的会话再 select 会触发 recompose → **丢 provider/model**
\t\t\t\t\t\t// （回落到 deepseek-official ⇒ no API key）。仅当会话是"已有会话被复用"
\t\t\t\t\t\t// （meta 未生效）时才需要 select。用 registry 的已有记录判断。
\t\t\t\t\t\tconst recorded = registry.presetForSession(rec.handle.agent.session);
\t\t\t\t\t\tif (recorded === null || recorded === undefined) {
\t\t\t\t\t\t\ttry {
\t\t\t\t\t\t\t\tawait registry.select(rec.handle.agent, preset);
\t\t\t\t\t\t\t} catch (err) {
\t\t\t\t\t\t\t\tconsole.warn(\`[vendor] session/create: select \${preset} 失败：\${err.message}\`);
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\treturn { sessionId: sid, agentPreset: preset ?? null };
\t\t\t}`;

const STEER_CASE = `
\t\t\tcase "session/steer": {
\t\t\t\t// vteam P5 vendor：在途注入（下一 step 边界消费）。
\t\t\t\tconst sid = params?.sessionId;
\t\t\t\tconst rec = typeof sid === "string" ? this.sessions.get(sid) : undefined;
\t\t\t\tif (!rec) throw new Error(\`session not found: \${String(sid)}\`);
\t\t\t\tconst blocks = Array.isArray(params?.contentBlocks) ? params.contentBlocks : [];
\t\t\t\tif (blocks.length === 0) throw new TypeError("session/steer requires non-empty contentBlocks");
\t\t\t\tconst text = blocks
\t\t\t\t\t.filter((b) => b && b.type === "text")
\t\t\t\t\t.map((b) => String(b.text ?? ""))
\t\t\t\t\t.join("");
\t\t\t\tconst message = {
\t\t\t\t\tid: \`steer-\${Date.now()}-\${Math.random().toString(36).slice(2, 10)}\`,
\t\t\t\t\tcontent: [{ type: "text", text }],
\t\t\t\t\tsource: { kind: "user" },
\t\t\t\t\trole: "user",
\t\t\t\t};
\t\t\t\trec.handle.agent.steer(message);
\t\t\t\treturn { accepted: true, messageId: message.id };
\t\t\t}`;

/** 锚点：switch 里 shutdown 那一行（保持其后的 default 分支不动）。 */
const ANCHOR = '\t\t\tcase "shutdown": return this.shutdown();';

/**
 * `createSession` 的 meta 补丁：让建会话时**直接带上 preset**。
 *
 * 为什么必须这样（实测踩坑）：`agentPresets.select()` 是**事后 recompose**——
 * 它把 agent 移到新 plugin scope，导致 `agentOptions` 的 provider/model 丢失，
 * 回落到 DSH 内置默认 `deepseek-official` ⇒ `no API key for provider route`。
 * 而 `CreateAgentOptions.meta.agentPreset`（packages/core/agent/src/index.ts:88）
 * 在**建会话时**就绑定 preset ⇒ 不会丢 model。
 */
/**
 * **流式转发补丁（P7）**：把 `agent/assistant-stream` 帧实时推给客户端。
 *
 * ## 为什么必须 vendor（上游没有这条通道）
 *
 * DSH 自身的 Web GUI 有逐字流式，但走的是**客户端内部机制**：
 * `packages/api/session-controller/src/client/sessions/assistant-stream.ts` 把
 * durable 的 `assistant/attempt`（含完整 `stream: StreamChunk[]`）在**客户端**展开
 * 成 transient 的 `assistant/live-chunk`。
 *
 * 而 SDK 协议（`session.event`）只转发 **durable** 事件 ⇒ `assistant/attempt` 是
 * attempt **结束后**才写入的一次性事件 ⇒ 客户端只能拿到整段，**没有逐字效果**。
 *
 * 但 DSH 内部**已经有实时帧机制**：
 * `packages/core/agent-loop/src/agent.ts:487` 构造 `AssistantStreamAttempt` 时传了
 * `(frame) => this.dispatch.emit('agent/assistant-stream', { frame })`，
 * 每个 token 都会触发一次（`live.push(chunk)` @ line 496）。
 *
 * 故本补丁：在 server 上订阅 `agent/assistant-stream`，把 `frame` 经
 * `session.event` 通知发给客户端（新增 `assistant/stream-frame` 事件类型）。
 *
 * 客户端（worker 驱动）据此累积文本 → 上送 `message.part.delta` ⇒ 前端逐字渲染。
 */
const CREATE_META_OLD = 'meta: { cwd: this.cwd },';
const CREATE_META_NEW = 'meta: { cwd: this.cwd, ...(this.__vteamPreset ? { agentPreset: this.__vteamPreset } : {}) },';

function main() {
  const explicitDir = process.argv[2];
  const target = resolveTargetPath(explicitDir);
  if (!existsSync(target)) {
    throw new Error(`目标文件不存在：${target}`);
  }

  const source = readFileSync(target, 'utf8');

  // 幂等：已有两个 case → 跳过
  const hasCancel = source.includes('case "session/cancel"');
  const hasSteer = source.includes('case "session/steer"');
  const hasCreate = source.includes('case "session/create"');
  if (hasCancel && hasSteer && hasCreate) {
    console.log('[vendor] 已打过补丁（create/cancel/steer 均存在），跳过');
    return;
  }

  if (!source.includes(ANCHOR)) {
    // 升级后锚点漂移 → 响亮失败（构建期暴露，而不是运行期静默丢功能）
    const switchIdx = source.indexOf('async handleRequest(');
    const excerpt = switchIdx >= 0 ? source.slice(switchIdx, switchIdx + 400) : source.slice(0, 400);
    throw new Error(
      '[vendor] 锚点未命中：SDK server 的 switch 结构可能已随上游升级变化。\n' +
        `  期望锚点：${JSON.stringify(ANCHOR)}\n` +
        `  实际片段：\n${excerpt}\n` +
        '  → 请对照新版 handleRequest 调整本脚本的 ANCHOR / CASE 模板。',
    );
  }

  // 备份一次（便于人工排查；不覆盖已有备份）
  const backup = `${target}.orig`;
  if (!existsSync(backup)) {
    copyFileSync(target, backup);
    console.log(`[vendor] 已备份原文件：${backup}`);
  }

  let patched = source;

  // ②' 流式帧转发：在 server 构造完成后订阅 agent/assistant-stream
  // 锚点：`this.disposers.push(ctx.on('session/event'` 之前，插一段订阅
  // 编译产物用**双引号**（源码是单引号，tsc 构建后转双引号）
  const STREAM_ANCHOR = 'this.disposers.push(ctx.on("session/event"';
  const STREAM_SUB = `this.disposers.push(ctx.on('agent/assistant-stream', ({ frame }) => {
\t\t\t\tconsole.error("[vendor] stream-frame", frame.type, String(frame.attemptId));\n\t\t\t\tconst sessionId = frame.attemptId.split(':')[0];
\t\t\t\tthis.transport.notify('session.event', {
\t\t\t\t\tsessionId,
\t\t\t\t\tevent: {
\t\t\t\t\t\ttype: 'assistant/stream-frame',
\t\t\t\t\t\t// 用高精度 seq 标记 transient（不参与 durable 顺序判定）
\t\t\t\t\t\tseq: -1,
\t\t\t\t\t\ttime: typeof frame.time === 'number' ? frame.time : Date.now(),
\t\t\t\t\t\tdata: { frame },
\t\t\t\t\t},
\t\t\t\t});
\t\t\t}), { global: true });
\t\t\t`;

  // ① meta 补丁：建会话**直接带 preset**（避免 select() 的 recompose 丢 model）
  if (patched.includes(CREATE_META_OLD)) {
    patched = patched.replace(CREATE_META_OLD, CREATE_META_NEW);
    console.log('[vendor]   meta 补丁：建会话支持 agentPreset');
  } else {
    throw new Error(
      '[vendor] createSession 的 meta 锚点未命中（上游结构可能变化）：' +
        `期望 ${JSON.stringify(CREATE_META_OLD)}`,
    );
  }
  // ②' 流式帧转发（P7）：订阅 agent/assistant-stream → 经 session.event 实时通知客户端
  if (patched.includes(STREAM_ANCHOR) && !patched.includes('assistant/stream-frame')) {
    patched = patched.replace(STREAM_ANCHOR, `${STREAM_SUB}${STREAM_ANCHOR}`);
    console.log('[vendor]   新增流式转发：agent/assistant-stream → session.event');
  } else if (!patched.includes('assistant/stream-frame')) {
    throw new Error('[vendor] 流式转发锚点未命中：session/event 订阅处结构可能变化');
  }

  // ③ 三个 case 插在 shutdown 之前（create → cancel → steer）
  patched = patched.replace(
    ANCHOR,
    `${CREATE_CASE}\n${CANCEL_CASE}\n${STEER_CASE}\n${ANCHOR}`,
  );

  // 结构断言：两处 case 必须都在，且 default 分支未被破坏
  if (
    !patched.includes('case "session/create"') ||
    !patched.includes('case "session/cancel"') ||
    !patched.includes('case "session/steer"')
  ) {
    throw new Error('[vendor] 注入后断言失败：case 未写入');
  }
  if (!patched.includes('default: throw new Error(')) {
    throw new Error('[vendor] 注入后断言失败：default 分支被破坏');
  }

  writeFileSync(target, patched, 'utf8');
  // 4) agent-loop 流式 hook（P7-b）
  // target = .../dsh/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js
  // 4 层 dirname 到 @deepseek-ai 的父目录（dsh/node_modules）
  const loopTarget = join(
    dirname(dirname(dirname(dirname(target)))),
    '@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js',
  );
  if (!existsSync(loopTarget)) {
    console.warn('[vendor]   warn: 未找到 dsh-agent-loop，跳过流式 hook');
  } else {
    const loopSource = readFileSync(loopTarget, 'utf8');
    if (loopSource.includes('vteam stream chunk hook')) {
      console.log('[vendor]   流式 hook 已存在，跳过');
    } else {
      const PUSH_OLD = '					live.push(chunk);';
      if (!loopSource.includes(PUSH_OLD)) {
        console.warn('[vendor]   warn: agent-loop live.push 锚点未命中');
      } else {
        const PUSH_NEW = [
          PUSH_OLD,
          '					// vteam stream chunk hook',
          '					try {',
          '						this.session.append("assistant/stream-chunk", { turn, step, chunk: JSON.parse(JSON.stringify(chunk)) }, { ignorable: true });',
          '					} catch { /* best effort */ }',
        ].join('\n');
        const loopPatched = loopSource.replace(PUSH_OLD, PUSH_NEW);
        if (loopPatched !== loopSource) {
          writeFileSync(loopTarget + '.orig', loopSource);
          writeFileSync(loopTarget, loopPatched);
          console.log('[vendor]   新增流式 hook: agent-loop token -> session/event');
        } else {
          console.warn('[vendor]   warn: 流式 hook 注入无变化');
        }
      }
    }
  }

  console.log(`[vendor] 补丁完成：${target}`);
  console.log('[vendor]   新增 session/create（建会话 + 绑定 agent preset）');
  console.log('[vendor]   新增 session/cancel（GUI 停止按钮语义，keepInbox=true）');
  console.log('[vendor]   新增 session/steer（在途注入，agent.steer）');
}

try {
  main();
} catch (err) {
  console.error(`[vendor] 失败：${err.message}`);
  process.exit(1);
}
