/**
 * D6 候选 (f)：vteam **逐消息 system blob** 的 v2 原生载体（**插件交接**）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 * opencode v2 的 `POST /api/session/{id}/prompt` body **没有 `system` 字段**
 * （`additionalProperties:false`，带上去 200 且被**静默忽略**）⇒ v1 的「逐消息 system」
 * 载体直接消失。而 vteam 的 blob（平台协议 / 岗位职责 / 派发规则 / 记忆规则 / 团队上下文…）
 * 是**逐派发、逐成员现拼**的 ⇒ 装不进静态的 `agents.<name>.system`（那是**逐 agent**的）。
 *
 * 过渡期兜底是**文本前缀**（计划 D6 兜底 (d)）：blob 拼在正文之前 ⇒ 落在模型的 **user 段**
 * ⇒ 模型把它当成"用户说的"而不是"系统指令"（**优先级更低**）。本模块提供**第二条路**：
 * 把 blob 送进**模型请求的 system 段**（T4 实测：v2 插件的 `ctx.session.hook("context", cb)`
 * → `event.system.push({type:"text", text})` **确实**进最终模型请求的 system 段）。
 *
 * ── 交接协议（worker ⇄ 插件） ───────────────────────────────────────────────
 * 插件跑在 **serve 进程内**（看不见 worker 的内存）⇒ 只能经**文件系统**交接：
 * 1. worker 在**下发 prompt 之前**把 blob **原样**写进
 *    `<workDir>/.vteam-system-handoff/<sessionID>.txt`（**原子写**：tmp + rename）；
 * 2. 插件在每次 `context` 组装（= 每次 primary 模型请求）时按 `event.sessionID` 读该文件，
 *    读到就 `event.system.push({type:"text", text})`；**读不到 → no-op**（不推空段）；
 * 3. 两条路**互斥**：驱动在走插件路时**不**拼文本前缀；走兜底时**清掉**交接文件
 *    ⇒ 同一段 blob **绝不**同时出现在 system 段与 user 段。
 *
 * ── 协商（**不**依赖 `GET /api/plugin`——那个端点实测不可靠） ────────────────
 * "插件路径是否真的在生效"用**两个文件系统事实**判定：
 * - **插件文件在位**（`<workDir>/.opencode/plugins/vteam-system-handoff.ts` 存在）
 *   ⇒ worker 侧产物已就位（老镜像 / 没注入 ⇒ 不在位 ⇒ 直接走文本前缀兜底）；
 * - **该会话所在 location 的就绪标记在位**
 *   （`<workDir>/.vteam-system-handoff/.ready/<location 哈希>.txt`，由插件 `setup` 写）
 *   ⇒ 插件**已被当前 serve 为该 location 加载**。
 *
 * ⚠️ **为什么就绪标记必须按 location 分桶**（实测 opencode v2.0.32）：
 * 插件是**按 location 加载**的（每个 location 一个插件实例、一次 `setup`；
 * 实测 serve 日志里同一份插件文件出现两次 "loading plugin"，对应两个 location）⇒
 * "插件在别处加载过"**不能**推出"本会话的 location 也加载了"。若用一个全局标记，
 * 新 location 的第一次派发会误判"插件已就绪"⇒ blob 写进交接文件却**没有任何 hook 读它**
 * ⇒ **blob 静默丢失**（最坏结果）。按 location 分桶后，判据与 hook 的注册范围**严格一致**。
 *
 * serve 重启后 worker 会清掉全部就绪标记 ⇒ 重新等插件加载（宁可退回前缀，也不丢 blob）。
 *
 * ── ⚠️ 缓存稳定性（**load-bearing**，改动前必读） ────────────────────────────
 * 插件在 agent 循环的**每一次**模型请求都会触发（**每个工具往返都是一次新的模型请求**），
 * 而 provider 侧的 prompt 缓存**按 token 前缀**命中 ⇒ 交接文件的内容必须**逐字节稳定**：
 * - 插件**只读不写**：读到啥推啥，**绝不**重新序列化 / 重排 / 加时间戳 / 加计数器；
 * - worker 也**只在内容真的变了**时才重写（compare-then-write：同内容不重写，
 *   省掉无谓 IO，也避免撕裂读的风险）；
 * - ⇒ "顺手在文件里加个当前时间戳方便排查"这类改动会**击穿整个会话的前缀缓存**
 *   （每次请求都是新前缀 ⇒ 全量重缓存）——**不要**这么做。
 *
 * 体积上限：交接目录内最多保留 `SYSTEM_HANDOFF_MAX_ENTRIES` 个会话条目
 * （超出按 mtime 淘汰最旧的）⇒ 目录**有界**，不会随会话数无界增长。
 *
 * ── 并发语义 ────────────────────────────────────────────────────────────────
 * 交接文件**按会话 id 命名** ⇒ 同一会话的并发派发**不会互相写坏**（写是 tmp + rename 的
 * **原子替换**，读者永远看到完整的一版）。同一会话的**并发**派发语义 = **后写者胜**
 * （与 v1 的 body 级 `system` 逐消息可变同源）；不同会话各写各的文件，互不影响。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 插件文件名（落在 `<workDir>/.opencode/plugins/` 下——v2 的插件发现路径）。 */
export const SYSTEM_HANDOFF_PLUGIN_FILE = 'vteam-system-handoff.ts';

/** 插件 id（稳定；作用域插件自身的 storage）。 */
export const SYSTEM_HANDOFF_PLUGIN_ID = 'vteam-system-handoff';

/**
 * 交接目录名（落在 **workDir** 下，**不在** `.opencode/` 里）。
 *
 * ⚠️ **为什么不放 `.opencode/` 下**：`.opencode/` 是 opencode 的**项目配置发现作用域**
 * （`plugins/` / `tools/` / `agent/` / `command/` / `skills/`…）⇒ 交接文件放进去有被
 * 当成配置产物扫描的风险。放在 workDir 的**同级兄弟目录**下：既不在配置作用域里，
 * 又与插件文件同处一个持久卷（worker 与 serve 同容器 ⇒ 同一文件系统 ⇒ 插件读得到）。
 */
export const SYSTEM_HANDOFF_DIR_NAME = '.vteam-system-handoff';

/** 就绪标记目录名（内含**按 location 分桶**的标记文件，由插件 `setup` 写）。 */
export const SYSTEM_HANDOFF_READY_DIR = '.ready';

/** 就绪标记文件名后缀（`.ready/<location 哈希>.txt`）。 */
const READY_FILE_SUFFIX = '.txt';

/** 交接目录内最多保留的会话条目数（超出按 mtime 淘汰最旧的 ⇒ 目录有界）。 */
export const SYSTEM_HANDOFF_MAX_ENTRIES = 64;

/** 交接文件名后缀（`<sessionID>.txt`）。 */
export const SYSTEM_HANDOFF_FILE_SUFFIX = '.txt';

/**
 * 会话 id 的合法形态（**两侧共用同一条正则**：worker 侧写文件、插件侧读文件）。
 *
 * ⚠️ 这条正则同时是**路径穿越的唯一防线**：会话 id 会被拼进文件名 ⇒ 只允许
 * `[A-Za-z0-9_-]`（opencode 的会话 id 形如 `ses_xxx`，天然满足）。
 * 不满足 ⇒ worker 侧**拒绝**走插件路（退回文本前缀），插件侧**跳过**（不注入）。
 */
export const HANDOFF_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * location 目录 → 就绪标记文件名（8 位十六进制）。
 *
 * ⚠️ **插件侧必须是同一套算法**（否则 worker 找不到插件写的标记 ⇒ 永远退回前缀兜底）。
 * 插件侧的实现由 `renderSystemHandoffPlugin` 渲染（同一套 FNV-1a），单测用
 * 「真的求值插件模块」验证两侧一致（见 `v2-system-handoff.spec.ts`）。
 *
 * 算法与 `browser-tools.ts` 的 `hashSeed` 同口径（FNV-1a 32 位）。
 */
export function locationHash(location: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < location.length; i++) {
    h ^= location.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 交接目录（`<workDir>/.vteam-system-handoff`）。 */
export function resolveSystemHandoffDir(workDir: string): string {
  return path.join(workDir, SYSTEM_HANDOFF_DIR_NAME);
}

/** 插件文件路径（`<workDir>/.opencode/plugins/vteam-system-handoff.ts`）。 */
export function resolveSystemHandoffPluginPath(workDir: string): string {
  return path.join(workDir, '.opencode', 'plugins', SYSTEM_HANDOFF_PLUGIN_FILE);
}

/** 某会话的交接文件路径（会话 id 非法时返回 null——调用方必须先过正则）。 */
export function resolveSystemHandoffFile(
  workDir: string,
  sessionID: string,
): string | null {
  if (!HANDOFF_SESSION_ID_RE.test(sessionID)) {
    return null;
  }
  return path.join(
    resolveSystemHandoffDir(workDir),
    `${sessionID}${SYSTEM_HANDOFF_FILE_SUFFIX}`,
  );
}

/**
 * 渲染 **v2 插件模块**（`.opencode/plugins/vteam-system-handoff.ts`）。
 *
 * 形态与既有生成器一致（`custom-tool.ts` / `git-tools.ts` / `browser-tools.ts`）：
 * - `Plugin.define({ id, setup })` + **动态** `import("@opencode/plugin")`（v1 二进制里
 *   没有这个包，静态 import 会让整个模块在 v1 下加载失败 ⇒ v1 静默跳过该插件）；
 * - 兜底分支里的 `define` 是 identity（`Plugin.define` 本身就是 identity function）
 *   ⇒ 展开后等价于 `{ id, setup, server }`，v1 走 `server()` 分支；
 * - `setup` 开头**必须**防呆（v1 也会调用 `setup`，而 v1 的 ctx 里没有 `ctx.session.hook`）。
 *
 * ⚠️ **hooks 不需要 `options: { codemode: false }`**：那个选项是**工具**的属性
 * （决定工具是"模型可直接 tool_calls"还是"只能经 Code Mode 的 execute 调用"）；
 * `ctx.session.hook(name, cb)` 注册的是**钩子**，不是模型可见的工具，也没有该选项
 * （`hook` 的第三参是**provider 作用域** `ModelHookOptions`，与 codemode 无关）。
 *
 * @param options.handoffDir 交接目录的**绝对路径**（注入时写死：插件与 worker 同容器同卷）
 */
export function renderSystemHandoffPlugin(options: { handoffDir: string }): string {
  const handoffDir = options.handoffDir;
  const lines: string[] = [];

  lines.push('/**');
  lines.push(' * vteam 逐消息 system blob 交接插件（D6 候选 (f)；由 worker 自动注入，勿手改）。');
  lines.push(' *');
  lines.push(' * 作用：把 worker 在**派发前**写好的「本次 system blob」推进**模型请求的 system 段**');
  lines.push(' * （`ctx.session.hook("context", cb)` → `event.system.push({type:"text", text})`）。');
  lines.push(' * v2 的 prompt body 没有 `system` 字段（`additionalProperties:false`，带上去被静默忽略），');
  lines.push(' * 而 vteam 的 blob 是**逐派发、逐成员现拼**的 ⇒ 装不进静态的 `agents.<name>.system`。');
  lines.push(' *');
  lines.push(' * 交接协议：');
  lines.push(' * - worker 在下发 prompt **之前**把 blob **原样**写进 `<交接目录>/<sessionID>.txt`；');
  lines.push(' * - 插件在每次 `context` 组装（= 每次 primary 模型请求）时按 `event.sessionID` 读它，');
  lines.push(' *   读到就推进 system 段；**读不到 → no-op**（不推空段）；');
  lines.push(' * - 两条路**互斥**：驱动走插件路时**不**拼文本前缀；走兜底时会清掉交接文件');
  lines.push(' *   ⇒ 同一段 blob **绝不**同时出现在 system 段与 user 段。');
  lines.push(' *');
  lines.push(' * ⚠️ **缓存稳定性（load-bearing，改动前必读）**：');
  lines.push(' * 本插件在 agent 循环的**每一次**模型请求都会触发（**每个工具往返都是一次新的');
  lines.push(' * 模型请求**），而 provider 侧的 prompt 缓存**按 token 前缀**命中 ⇒ 交接文件的');
  lines.push(' * 内容必须**逐字节稳定**：本插件**只读不写**（读到啥推啥，绝不重新序列化 / 重排 /');
  lines.push(' * 加时间戳 / 加计数器），worker 也只在内容**真的变了**时才重写。');
  lines.push(' * 任何"顺手加个当前时间戳方便排查"的改动都会**击穿整个会话的前缀缓存**');
  lines.push(' * （每次请求都是新前缀 ⇒ 全量重缓存）——**不要**这么做。');
  lines.push(' */');
  lines.push('import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"');
  lines.push('import { join } from "node:path"');
  lines.push('');
  lines.push('/**');
  lines.push(' * v2 插件 API（`@opencode/plugin`）。');
  lines.push(' *');
  lines.push(' * ⚠️ **必须动态 import**：v1（1.18.x）二进制里**没有**这个包（静态 import 会让整个');
  lines.push(' * 模块在 v1 下加载失败——v1 静默跳过该插件）；v2 宿主**内置**该模块（动态 import 可');
  lines.push(' * 解析，**不需要** work dir 里有 node_modules）。');
  lines.push(' * 兜底分支里的 `define` 是 identity（@opencode/plugin 里 `Plugin.define` 本身就是');
  lines.push(' * identity function）→ 展开后等价于 `{ id, setup, server }`，v1 走 `server()` 分支。');
  lines.push(' */');
  lines.push('const { Plugin } = (await import("@opencode/plugin").catch(() => ({');
  lines.push('  Plugin: { define: (plugin: unknown) => plugin },');
  lines.push('}))) as unknown as typeof import("@opencode/plugin")');
  lines.push('');
  lines.push('/** 交接目录（worker 注入时写死；worker 与 serve 同容器 ⇒ 同一文件系统）。 */');
  lines.push(`const HANDOFF_DIR = ${JSON.stringify(handoffDir)}`);
  lines.push('');
  lines.push('/**');
  lines.push(' * 会话 id 的合法形态（与 worker 侧**同一条正则**——两侧必须一致，故由 worker 生成此文件）。');
  lines.push(' * 这条正则同时是**路径穿越的唯一防线**：会话 id 会被拼进文件名。');
  lines.push(' */');
  lines.push(
    `const SESSION_ID_RE = new RegExp(${JSON.stringify(HANDOFF_SESSION_ID_RE.source)})`,
  );
  lines.push('');
  lines.push('/**');
  lines.push(' * location 目录 → 就绪标记文件名（8 位十六进制）。');
  lines.push(' *');
  lines.push(' * ⚠️ **必须与 worker 侧同一套算法**（否则 worker 找不到本文件写的标记 ⇒ 永远退回');
  lines.push(' * 文本前缀兜底）。算法 = FNV-1a 32 位（与 browser-tools 的 hashSeed 同口径）。');
  lines.push(' */');
  lines.push('function __vteam_locationHash(location: string): string {');
  lines.push('  let h = 0x811c9dc5;');
  lines.push('  for (let i = 0; i < location.length; i++) {');
  lines.push('    h ^= location.charCodeAt(i);');
  lines.push('    h = Math.imul(h, 0x01000193) >>> 0;');
  lines.push('  }');
  lines.push('  return h.toString(16).padStart(8, "0");');
  lines.push('}');
  lines.push('');
  lines.push('/**');
  lines.push(' * 写**本 location** 的就绪标记（协商用）：worker 据此判定"插件已为该 location 加载"。');
  lines.push(' *');
  lines.push(' * ⚠️ **必须按 location 分桶**：v2 的插件是**按 location 加载**的（每个 location 一个');
  lines.push(' * 插件实例、一次 setup）⇒ "别的 location 加载过"推不出"本 location 加载了"。');
  lines.push(' * 用一个全局标记会让新 location 的第一次派发误判就绪 ⇒ blob 写进交接文件却**没有');
  lines.push(' * hook 读它** ⇒ blob 静默丢失。');
  lines.push(' */');
  lines.push('function markLocationReady(location: string): void {');
  lines.push('  if (typeof location !== "string" || location === "") return;');
  lines.push('  try {');
  lines.push('    const dir = join(HANDOFF_DIR, ".ready");');
  lines.push('    mkdirSync(dir, { recursive: true });');
  lines.push('    writeFileSync(join(dir, __vteam_locationHash(location) + ".txt"), location, "utf8");');
  lines.push('  } catch {}');
  lines.push('}');
  lines.push('');
  lines.push('/**');
  lines.push(' * 读某会话的交接 blob。');
  lines.push(' *');
  lines.push(' * @returns blob **原文**（逐字节原样返回，绝不重新序列化）；没有交接文件 / 读失败 /');
  lines.push(' *          内容为空 → null（调用方**不注入**，绝不推空段）。');
  lines.push(' */');
  lines.push('function readBlob(sessionID: string): string | null {');
  lines.push('  if (!SESSION_ID_RE.test(sessionID)) return null');
  lines.push('  try {');
  lines.push('    const file = join(HANDOFF_DIR, sessionID + ".txt")');
  lines.push('    if (!existsSync(file)) return null');
  lines.push('    const text = readFileSync(file, "utf8")');
  lines.push('    return text === "" ? null : text');
  lines.push('  } catch {');
  lines.push('    return null');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('export default {');
  lines.push('  ...Plugin.define({');
  lines.push(`    id: ${JSON.stringify(SYSTEM_HANDOFF_PLUGIN_ID)},`);
  lines.push('    async setup(ctx: any) {');
  lines.push('      // ⚠️ v1 也会调用 setup（v1 的 plugin ctx 里没有 ctx.session.hook）→ 必须防呆，否则 v1 会炸');
  lines.push('      if (!ctx?.session?.hook) return');
  lines.push('      await ctx.session.hook("context", (event: any) => {');
  lines.push('        const sessionID = event?.sessionID');
  lines.push('        if (typeof sessionID !== "string" || sessionID === "") return');
  lines.push('        const blob = readBlob(sessionID)');
  lines.push('        // 没有交接文件 → no-op（**绝不**推空段：那会让 system 段多一个空 part）');
  lines.push('        if (blob === null) return');
  lines.push('        // 直接推进模型请求的 system 段（= v1 的 body 级 `system` 的等价落点）');
  lines.push('        event.system.push({ type: "text", text: blob })');
  lines.push('      })');
  lines.push('      // 就绪标记（协商用）：worker 据此判定"插件已为**本 location** 加载"——');
  lines.push('      // **不**依赖 `GET /api/plugin`（那个端点实测不可靠）。');
  lines.push('      // serve 重启后 worker 会清掉全部标记 → 重新等插件加载。');
  lines.push('      markLocationReady(ctx?.location?.directory ?? "");');
  lines.push('    },');
  lines.push('  }),');
  lines.push('  async server() {');
  lines.push('    // v1 分支：v1 的 prompt body **有** `system` 字段（原生落点）→ 本插件在 v1 上是 no-op');
  lines.push('    return {}');
  lines.push('  },');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

/**
 * 把插件产物写进 `<workDir>/.opencode/plugins/`（v2 的插件发现路径）。
 *
 * ⚠️ 必须是**项目侧**（不是全局 `HOME`）：serve 跑在**隔离配置域**里
 * （`HOME`/`XDG_*` → 隔离根），宿主的全局配置/全局插件**不在作用域内** ⇒ 插件必须落在
 * **项目** `.opencode/plugins/` 下才会被加载（与 git/browser 工具插件同一条已验证路径）。
 *
 * @returns 写入的文件路径；失败抛错（调用方决定是否阻断启动）。
 */
export function installSystemHandoffPlugin(workDir: string): string {
  const filePath = resolveSystemHandoffPluginPath(workDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    renderSystemHandoffPlugin({ handoffDir: resolveSystemHandoffDir(workDir) }),
    'utf8',
  );
  return filePath;
}

/** 交接通道日志接口（默认静默；测试可注入断言）。 */
export interface SystemHandoffLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

/**
 * 交接通道端口（驱动只依赖这个接口——单测可注入假实现，不碰真实文件系统）。
 *
 * ⚠️ 语义约定（**驱动据此决定"拼前缀还是走插件"**）：
 * - `pluginInstalled()` = 插件**产物**在位（老镜像 / 没注入 ⇒ false ⇒ 直接走前缀兜底）；
 * - `pluginReady()` = 插件**已被当前 serve 加载**（就绪标记在位）；
 * - `deliver()` 返回 true = blob **已交付**（驱动据此**不**拼前缀）；
 * - `clear()` = 清掉该会话的交接文件（走前缀兜底时**必须**调用，否则会重复注入）。
 */
export interface SystemHandoffPort {
  pluginInstalled(): boolean;
  /** 该 location 的就绪标记是否在位（插件已为该 location 加载）。 */
  locationReady(location: string): boolean;
  /** 有界等待该 location 的就绪标记出现（location 首次启动时插件是**惰性加载**的）。 */
  awaitLocationReady(location: string, timeoutMs?: number): Promise<boolean>;
  /** 交付 blob（compare-then-write；返回 false = 写盘失败 ⇒ 调用方退回前缀兜底）。 */
  deliver(sessionID: string, blob: string): boolean;
  /** 清掉某会话的交接文件（幂等）。 */
  clear(sessionID: string): void;
}

/** 等待插件就绪的最长时长 ms（只在"插件文件在位但尚未加载"时发生，且有冷却）。 */
export const SYSTEM_HANDOFF_READY_WAIT_MS = 2_000;

/** 等待冷却 ms（等待失败后，冷却期内不再重复等待 ⇒ 不给每次派发都加延迟）。 */
export const SYSTEM_HANDOFF_READY_WAIT_COOLDOWN_MS = 30_000;

/** 轮询间隔 ms（等就绪标记）。 */
const READY_POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 交接通道的文件系统实现（worker 侧）。
 *
 * 生命周期：
 * - **写一次、读多次**：同一会话的 blob 内容不变 ⇒ **不重写**（compare-then-write）；
 *   内容真的变了才重写（此时 provider 侧的前缀缓存会从那一刻起重新建立——**罕见**，
 *   与 v1 的 body 级 `system` 逐消息可变的语义一致）。
 * - **有界**：目录内最多 `SYSTEM_HANDOFF_MAX_ENTRIES` 个条目，超出按 mtime 淘汰最旧的。
 * - **互斥**：驱动走前缀兜底时调用 `clear()` ⇒ 插件不会把同一段 blob 也推进 system 段。
 */
export class SystemHandoffStore implements SystemHandoffPort {
  private readonly workDir: string;
  private readonly logger?: SystemHandoffLogger;
  /** 上次"等待就绪"的时刻（按 location 分桶；冷却用）。 */
  private readonly lastWaitAt = new Map<string, number>();
  /** 临时文件序号（同进程内自增，避免并发写同名 tmp）。 */
  private tmpCounter = 0;

  constructor(workDir: string, options: { logger?: SystemHandoffLogger } = {}) {
    this.workDir = workDir;
    this.logger = options.logger;
  }

  /** 交接目录绝对路径。 */
  get dir(): string {
    return resolveSystemHandoffDir(this.workDir);
  }

  /** 就绪标记目录（`.ready/`，内含按 location 分桶的标记文件）。 */
  get readyDir(): string {
    return path.join(this.dir, SYSTEM_HANDOFF_READY_DIR);
  }

  /** 插件产物是否在位（`<workDir>/.opencode/plugins/vteam-system-handoff.ts`）。 */
  pluginInstalled(): boolean {
    try {
      return fs.existsSync(resolveSystemHandoffPluginPath(this.workDir));
    } catch {
      return false;
    }
  }

  /**
   * 插件是否已为**该 location** 加载（该 location 的就绪标记在位且内容对得上）。
   *
   * ⚠️ location 为空串 ⇒ 会话停在 serve 的**默认 location**（= serve 的 cwd = workDir）
   * ⇒ 用 workDir 作键（serve 由 worker 以 `cwd=workDir` 拉起，见 `OpencodeServer`）。
   */
  locationReady(location: string): boolean {
    const key = this.locationKey(location);
    try {
      const raw = fs.readFileSync(
        path.join(this.readyDir, `${locationHash(key)}${READY_FILE_SUFFIX}`),
        'utf8',
      );
      return raw === key;
    } catch {
      return false;
    }
  }

  /**
   * 让全部就绪标记失效（serve 重启后调用）。
   *
   * 为什么必须清：就绪标记是"**当前这个 serve 进程**为该 location 加载过插件"的证据；
   * serve 重启后插件要**重新**加载（发现是按 location 惰性的）⇒ 旧标记是**过期**的
   * ⇒ 继续信它会让驱动以为插件在生效，而实际上这一轮可能还没加载 ⇒ blob 丢失。
   * 清掉之后驱动会退回"有界等待就绪"，等不到就**走前缀兜底**（绝不丢 blob）。
   */
  invalidateReady(): void {
    try {
      fs.rmSync(this.readyDir, { recursive: true, force: true });
    } catch {
      // best-effort：清不掉就退回"标记过期"的保守判定（等不到就退回前缀兜底）
    }
  }

  /**
   * 有界等待插件为**该 location** 就绪。
   *
   * 冷却：等待失败后 `SYSTEM_HANDOFF_READY_WAIT_COOLDOWN_MS` 内不再等待（按 location 分桶）
   * ⇒ 插件坏了也**不会**给每次派发都加 2 秒延迟。
   */
  async awaitLocationReady(
    location: string,
    timeoutMs: number = SYSTEM_HANDOFF_READY_WAIT_MS,
  ): Promise<boolean> {
    const key = this.locationKey(location);
    if (this.locationReady(key)) {
      return true;
    }
    const now = Date.now();
    const last = this.lastWaitAt.get(key) ?? 0;
    if (now - last < SYSTEM_HANDOFF_READY_WAIT_COOLDOWN_MS) {
      return false;
    }
    this.lastWaitAt.set(key, now);
    const deadline = now + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      await sleep(READY_POLL_INTERVAL_MS);
      if (this.locationReady(key)) {
        return true;
      }
    }
    return false;
  }

  /** location 键：空串 ⇒ serve 的默认 location（= workDir）。 */
  private locationKey(location: string): string {
    return location === '' ? this.workDir : location;
  }

  /**
   * 交付 blob：写交接文件（原子：tmp + rename）。
   *
   * - **compare-then-write**：内容相同 ⇒ **不重写**（保持 inode/mtime 不变
   *   ⇒ 不产生无谓 IO，也不给并发读制造撕裂窗口）；
   * - 内容变了 ⇒ 重写并**显式告警**（provider 侧的前缀缓存会从那一刻起重新建立——
   *   与 v1 的 body 级 `system` 逐消息可变同源，**罕见**）；
   * - 会话 id 非法 / 写盘失败 ⇒ 返回 false（调用方退回文本前缀兜底，**绝不**抛错中断下发）。
   */
  deliver(sessionID: string, blob: string): boolean {
    const file = resolveSystemHandoffFile(this.workDir, sessionID);
    if (file === null) {
      this.logger?.warn?.(
        `[system-handoff] 会话 id 形态非法（不满足 ${HANDOFF_SESSION_ID_RE.source}），` +
          '本次不走插件路径（退回文本前缀兜底）',
      );
      return false;
    }
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      existing = null;
    }
    if (existing === blob) {
      // 逐字节相同 ⇒ **不重写**（write-once 语义：文件保持稳定，前缀缓存不受影响）
      return true;
    }
    if (existing !== null) {
      this.logger?.warn?.(
        `[system-handoff] 会话 ${sessionID} 的 blob 内容发生变化（重写交接文件）：` +
          'provider 侧的 prompt 前缀缓存会从这一刻起重新建立（与 v1 的逐消息 system 同源语义）',
      );
    }
    const tmp = `${file}.tmp-${process.pid}-${(this.tmpCounter += 1)}`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, blob, 'utf8');
      // rename 在同一目录内是**原子**替换 ⇒ 插件侧永远读到完整的一版（不会读到半截）
      fs.renameSync(tmp, file);
      this.sweep();
      return true;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // best-effort
      }
      this.logger?.warn?.(
        `[system-handoff] 交接文件写入失败（${err instanceof Error ? err.message : String(err)}）：` +
          '本次退回文本前缀兜底',
      );
      return false;
    }
  }

  /** 清掉某会话的交接文件（幂等；走前缀兜底时必须调用）。 */
  clear(sessionID: string): void {
    const file = resolveSystemHandoffFile(this.workDir, sessionID);
    if (file === null) {
      return;
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best-effort：清不掉不算失败（下一轮 deliver 会覆盖它）
    }
  }

  /** 读某会话的交接 blob（测试与排障用；无文件 → null）。 */
  read(sessionID: string): string | null {
    const file = resolveSystemHandoffFile(this.workDir, sessionID);
    if (file === null) {
      return null;
    }
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * 目录有界：条目数超过上限时，按 mtime 淘汰**最旧**的（就绪标记不计入）。
   *
   * 正在跑的会话，其文件是**刚写**的 ⇒ mtime 最新 ⇒ 不会被淘汰。
   */
  private sweep(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const blobs = entries.filter(
      (name) =>
        name !== SYSTEM_HANDOFF_READY_DIR && name.endsWith(SYSTEM_HANDOFF_FILE_SUFFIX),
    );
    if (blobs.length <= SYSTEM_HANDOFF_MAX_ENTRIES) {
      return;
    }
    const stamped = blobs
      .map((name) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(this.dir, name)).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { name, mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = stamped.length - SYSTEM_HANDOFF_MAX_ENTRIES;
    for (let i = 0; i < excess; i++) {
      try {
        fs.rmSync(path.join(this.dir, stamped[i].name), { force: true });
      } catch {
        // best-effort
      }
    }
  }
}
