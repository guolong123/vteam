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
import { join } from 'node:path';

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
\t\t\t\tconst rec = await this.getOrCreateSession(sid);
\t\t\t\tconst preset = params?.agentPreset;
\t\t\t\tconst presetPlugins = params?.agentPresetPlugins;
\t\t\t\tif (typeof preset === "string" && preset.length > 0) {
\t\t\t\t\tconst registry = this.ctx.get("agentPresets");
\t\t\t\t\tif (registry === undefined) {
\t\t\t\t\t\tconsole.warn(\`[vendor] session/create: agentPreset=\${preset} 但未挂载 preset registry（profile 未配置 roster）→ 忽略\`);
\t\t\t\t\t} else {
\t\t\t\t\t\t// 运行时注册：若调用方带了 plugins，就用它注册/覆盖该 preset。
\t\t\t\t\t\t// 这是 vteam 的**核心通道**——server 派发时下发的完整角色提示词
\t\t\t\t\t\t// （buildSystemInstructions，数千字）在这里变成该会话专属的
\t\t\t\t\t\t// preset persona prefix，且**不重启运行时**、**不污染用户消息**。
\t\t\t\t\t\tif (Array.isArray(presetPlugins) && presetPlugins.length > 0) {
\t\t\t\t\t\t\ttry {
\t\t\t\t\t\t\t\tawait registry.register({
\t\t\t\t\t\t\t\t\tid: preset,
\t\t\t\t\t\t\t\t\tname: params?.agentPresetName ?? preset,
\t\t\t\t\t\t\t\t\tplugins: presetPlugins,
\t\t\t\t\t\t\t\t});
\t\t\t\t\t\t\t} catch (err) {
\t\t\t\t\t\t\t\t// 已存在（同 id 静态 roster）→ 忽略；其它错误告警
\t\t\t\t\t\t\t\tif (!/Duplicate agent preset/i.test(err.message)) {
\t\t\t\t\t\t\t\t\tconsole.warn(\`[vendor] session/create: 运行时注册 preset \${preset} 失败：\${err.message}\`);
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t\t// select 要求首 turn 之前；已跑过 turn 会抛 agent-preset/locked
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\tawait registry.select(rec.handle.agent, preset);
\t\t\t\t\t\t} catch (err) {
\t\t\t\t\t\t\tconsole.warn(\`[vendor] session/create: preset \${preset} 选择失败（会话可能已开始）：\${err.message}\`);
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\treturn { sessionId: sid, agentPreset: typeof preset === "string" ? preset : null };
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
  // 三个 case 插在 shutdown 之前（create → cancel → steer）
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
