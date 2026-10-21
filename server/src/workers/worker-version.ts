/**
 * opencode 版本串归一（**server 侧副本**；双写自
 * `worker/src/runtime/opencode-version.ts` 的 `parseOpencodeVersion` /
 * `formatOpencodeVersion` / `normalizeOpencodeVersion`）。
 *
 * 为什么控制面也要归一（计划 §9.4 混跑期调度）：
 * - worker 上报的 `opencodeVersion` 是**规范化 semver 串**（如 `2.0.28`，T1 起），
 *   而 CLI 原始输出是 `opencode v2.0.28`；旧 worker 上报的也可能是原始串。
 * - 调度器按版本过滤 worker（`assignWorker` 的第③道过滤）。若两侧格式不一致
 *   （worker 报 `2.0.28`、需求写 `opencode v2.0.28`），**精确串相等**会匹配不上 →
 *   worker **不可调度**，且**全程无报错**（静默的总停摆：什么都不派发）。
 * - ⇒ **两侧都比归一后的值**：格式差异被吸收，匹配只认语义。
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
 * 宽松版本号正则：兼容三种形态
 * - v2 形：`opencode v2.0.28`
 * - v1 形：`opencode 1.19.0`
 * - 裸 semver：`2.0.28`（worker 内部上报值即此形态）
 * 取**首个**匹配（`exec` 而非全局匹配），因此 `1.19.0-fake` 也能解析出 1.19.0。
 */
const VERSION_RE = /v?(\d+)\.(\d+)\.(\d+)/;

/**
 * 解析版本串（`opencode --version` 的输出形态）。
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
 */
export function formatOpencodeVersion(info: OpencodeVersionInfo): string {
  if (info.major === null || info.minor === null || info.patch === null) {
    return 'unknown';
  }
  return `${info.major}.${info.minor}.${info.patch}`;
}

/**
 * 上报值/需求值归一：可解析 → semver 串；**不可解析 → 原样返回**（保留 `'unknown'`
 * 等既有语义，避免把「未知」悄悄改成别的字面量）。
 */
export function normalizeOpencodeVersion(raw: string): string {
  const semver = formatOpencodeVersion(parseOpencodeVersion(raw));
  return semver === 'unknown' ? (raw ?? '').trim() : semver;
}

/**
 * 两个版本串是否指同一个版本（**先归一再比**）。
 *
 * - `'2.0.28'` vs `'2.0.28'` → 同；
 * - `'opencode v2.0.28'` vs `'2.0.28'` → 同（格式差异被吸收）；
 * - `'1.19.3'` vs `'2.0.28'` → 不同（混跑期隔离靠它）。
 */
export function isSameOpencodeVersion(a: string, b: string): boolean {
  return normalizeOpencodeVersion(a) === normalizeOpencodeVersion(b);
}
