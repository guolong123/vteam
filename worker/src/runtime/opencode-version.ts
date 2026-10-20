/**
 * opencode CLI 版本解析 + 启动期版本闸门（T1 / 计划 D2；**T18 起单模**）。
 *
 * 为什么单独成文件：`worker/src/index.ts`（启动信息）与 `worker/src/runtime/opencode-server.ts`
 * （serve 编排）**各自独立**跑一次 `opencode --version`，两处必须共用同一个解析器，
 * 否则版本串格式会再次分叉（v1 形 `opencode 1.19.0` vs v2 形 `opencode v2.0.28`）。
 *
 * 契约要点（实测 opencode v2.0.28）：
 * - v2：`opencode --version` → `opencode v2.0.28`（多 `v` 前缀）
 * - v1：`opencode --version` → `opencode 1.19.0`（冻结在 1.19.3，永不到 v2）
 * - 解析器必须**宽松**：认不出就降级为 unknown，**绝不抛错**（计划 D2 风险对策：
 *   输出格式再变时不能误杀 worker 启动；由控制面按版本串精确过滤兜底）。
 *
 * ⚠️ **T18：闸门不再分模式**——v1 驱动已删除，闸门**无条件**要求主版本 ≥ 2。
 */

/** 解析结果：认不出的字段一律为 null（不抛错）。 */
export interface OpencodeVersionInfo {
  /** 主版本号；解析失败为 null */
  major: number | null;
  /** 次版本号；解析失败为 null */
  minor: number | null;
  /** 修订号；解析失败为 null */
  patch: number | null;
  /** 原始输出（trim 后），供日志/错误信息使用 */
  raw: string;
}

/**
 * worker 要求的 opencode 主版本下限。
 * v2 才是目标契约（/api 前缀、content[]、durable.seq、恒开鉴权…），v1 线已冻结。
 */
export const MIN_OPENCODE_MAJOR = 2;

/**
 * 锁版规格（与 `worker/Dockerfile` 的 `ARG OPENCODE_CLI_SPEC` 默认值保持一致）。
 * v1 的 npm 包 `opencode-ai` 冻结在 1.19.3，永远到不了 v2；v2 换包名为 `@opencode/cli`。
 */
export const REQUIRED_OPENCODE_CLI_SPEC = '@opencode/cli@2.0.32';

/**
 * 宽松版本号正则：兼容三种形态
 * - v2 形：`opencode v2.0.28`
 * - v1 形：`opencode 1.19.0`
 * - 裸 semver：`2.0.28`（worker 内部上报值即此形态）
 * 取**首个**匹配（`exec` 而非全局匹配），因此 `1.19.0-fake` 也能解析出 1.19.0。
 */
const VERSION_RE = /v?(\d+)\.(\d+)\.(\d+)/;

/**
 * 解析 `opencode --version` 的输出。
 *
 * 永不抛错：认不出 → 三个数字全为 null（调用方据此降级为 unknown + 告警）。
 */
export function parseOpencodeVersion(raw: string): OpencodeVersionInfo {
  const text = (raw ?? '').trim();
  const match = VERSION_RE.exec(text);
  if (!match) {
    return { major: null, minor: null, patch: null, raw: text };
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: text,
  };
}

/**
 * 规范化 semver 串（`2.0.28`）；解析失败返回 `'unknown'`。
 * 控制面的调度器按**精确字符串相等**过滤 worker（`workers.service.ts` 的
 * `opencodeVersion` 比较），所以上报值必须是规范化 semver，不能是 `opencode v2.0.28` 全文。
 */
export function formatOpencodeVersion(info: OpencodeVersionInfo): string {
  if (info.major === null || info.minor === null || info.patch === null) {
    return 'unknown';
  }
  return `${info.major}.${info.minor}.${info.patch}`;
}

/**
 * 上报值规范化：可解析 → semver 串；**不可解析 → 原样返回**（保留 `'unknown'` 等既有语义，
 * 避免把「未知」悄悄改成别的字面量）。
 */
export function normalizeOpencodeVersion(raw: string): string {
  const semver = formatOpencodeVersion(parseOpencodeVersion(raw));
  return semver === 'unknown' ? (raw ?? '').trim() : semver;
}

/** 版本闸门的告警出口（默认 console.warn）。 */
export interface VersionGateLogger {
  warn(message: string): void;
}

/**
 * 版本闸门选项。
 *
 * ⚠️ `warn` 是**便捷写法**（等价 `logger.warn`）：既有调用点传的就是 `{warn}` 形态，
 * 保持兼容即不必改全部调用方。
 *
 * ⚠️ **T18 起闸门单模**（不再有 `mode` 选项）：v1 驱动已删除，worker 只有一种驱动实现，
 * 故「按模式放宽版本要求」这件事已不存在——闸门**无条件**要求主版本 ≥ 2。
 */
export interface VersionGateOptions {
  /** 告警出口（缺省 = 不告警） */
  logger?: VersionGateLogger;
  /** 便捷写法：直接给 warn 函数 */
  warn?: (message: string) => void;
}

/** 告警出口统一取用（优先 logger，其次便捷 warn）。 */
function emitGateWarn(options: VersionGateOptions, message: string): void {
  if (options.logger) {
    options.logger.warn(message);
    return;
  }
  options.warn?.(message);
}

/**
 * 启动期版本闸门（计划 D2：主版本 < 2 → fail-fast 并给出可操作错误）。
 *
 * ⚠️ **T18 起单模**（不再按驱动模式放宽）：v1 驱动已删除，worker 只有 v2 一种实现，
 * 故闸门**无条件**要求主版本 ≥ 2——「退回 v1」不再是代码级选项（唯一回退是回滚镜像/代码，
 * 见 `driver/index.ts` 的 `V1_DRIVER_REMOVED_MESSAGE`）。
 *
 * | 检测到的版本 | 结论 |
 * |-------------|------|
 * | major ≥ 2 | 放行 |
 * | major = 1 | fail-fast（镜像没换 CLI 规格，继续跑只会拿到 v1 契约） |
 * | 认不出（major = null） | **只告警不判死**（计划 D2 风险对策：输出格式再变也不能误杀启动） |
 */
export function assertOpencodeVersionSupported(
  info: OpencodeVersionInfo,
  options: VersionGateOptions = {},
): void {
  if (info.major === null) {
    emitGateWarn(
      options,
      `[opencode-version] 无法判定 opencode 版本（原始输出: "${info.raw}"），继续启动；` +
        '控制面按版本串精确过滤兜底，请确认镜像内 opencode 是否为 ' +
        REQUIRED_OPENCODE_CLI_SPEC,
    );
    return;
  }
  if (info.major < MIN_OPENCODE_MAJOR) {
    throw new Error(
      `[opencode-version] 需要 opencode >= ${MIN_OPENCODE_MAJOR}，当前 ${info.raw || 'unknown'}；` +
        `请重建 worker 镜像并设置 --build-arg OPENCODE_CLI_SPEC=${REQUIRED_OPENCODE_CLI_SPEC}`,
    );
  }
}
