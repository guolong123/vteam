/**
 * Worker 日志时间戳（2026-11-27）。
 *
 * 背景：worker 日志此前没有任何时间前缀，长会话里 `[prompt-await] 轮询`、
 * `[mcp-status] 探测失败` 刷屏后无法判断"哪一条发生在什么时候"，排障时
 * 只能靠外部日志系统的采集时间（往往与实际事件相差数秒到数十秒）。
 *
 * 在 `main()` 入口统一给 console.log/info/warn/error 打 ISO 时间前缀：
 * - 一处生效，覆盖 worker 自己所有模块（含通过 logger 接缝传进去的
 *   console.* 包装）以及第三方依赖写到 console 的内容；
 * - 只在进程启动时安装一次，重复调用幂等（测试里多次 main() 不会叠加前缀）；
 * - 多行消息只给首行加前缀，保留原文其余行（避免破坏堆栈/JSON 片段的可读性）。
 */

type ConsoleMethod = (...args: unknown[]) => void;

let installed = false;

/** ISO 8601 时间戳（含毫秒，UTC；与外部日志采集时间同口径）。 */
export function logTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}

/** 给一条 console 调用加时间前缀；非字符串首参（对象等）前置独立时间参数。 */
export function withLogTimestamp(args: unknown[], now: Date = new Date()): unknown[] {
  const prefix = `[${logTimestamp(now)}]`;
  if (typeof args[0] === 'string') {
    return [`${prefix} ${args[0]}`, ...args.slice(1)];
  }
  return [prefix, ...args];
}

/**
 * 幂等安装：包装目标 console 的 log/info/warn/error，给每条输出加时间前缀。
 * @returns true = 本次调用完成安装；false = 已安装过（不重复包装）。
 */
export function installTimestampedConsole(target: Console = console): boolean {
  if (installed) {
    return false;
  }
  installed = true;
  const wrap = (original: ConsoleMethod): ConsoleMethod =>
    (...args: unknown[]): void => {
      original(...withLogTimestamp(args));
    };
  target.log = wrap(target.log.bind(target)) as typeof target.log;
  target.info = wrap(target.info.bind(target)) as typeof target.info;
  target.warn = wrap(target.warn.bind(target)) as typeof target.warn;
  target.error = wrap(target.error.bind(target)) as typeof target.error;
  return true;
}

/** 仅供测试重置安装状态（生产代码不调用）。 */
export function resetTimestampedConsoleForTest(): void {
  installed = false;
}
