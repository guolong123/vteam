import { createHash } from 'crypto';

/**
 * 评审轮次账本（plan-review-execution-gates todo 6；docs 33 §3.1）。
 *
 * 存放约定：不建新表。账本以内嵌机器段形式存放在派发 issue 的
 * `description` 内容区（人类可读文本 + 机器段共存），派发 issue 即
 * 轮次宿主 issue（plan↔task↔issue 链接靠派发时写回 `issueId`）。
 * 机器段分隔符逐字节固定为 `<!-- REVIEW-ROUND-JSON -->`，其后跟
 * fenced JSON 代码块（```json ... ```）。
 *
 * JSON Schema（schemaVersion 恒为 1，必填）：
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "round": 2,
 *   "planVersion": { "version": "v0.3", "lines": 233, "hash": "a1b2c3d4" },
 *   "planPath": ".opencode/plans/alert-analyzer-fix-iteration-plan.md",
 *   "taskId": "t_0000000001",
 *   "issueId": "is_0000000007",
 *   "expected": ["tmm_0000000012", "tmm_0000000009", "tmm_0000000010"],
 *   "expectedRoles": ["架构视角", "开发视角", "测试视角"],
 *   "received": {
 *     "tmm_0000000010": { "verdict": "APPROVE", "msgId": "m_0000000540", "version": "v0.3" }
 *   },
 *   "pending": [
 *     { "member": "tmm_0000000012", "verdict": "APPROVE", "msgId": "m_9", "version": "v0.3", "reason": "pending-hash" }
 *   ],
 *   "superseded": [
 *     { "member": "tmm_0000000010", "verdict": "REJECT", "msgId": "m_510", "version": "v0.2" }
 *   ],
 *   "status": "collecting",
 *   "timeoutAt": "2026-09-16T00:40:00Z"
 * }
 * ```
 *
 * 字段语义（docs 33 §3.3-§3.4）：
 * - `planVersion.hash`：计划文件落盘内容的 sha1 前 8，由计划员修订落盘钩
 *   在落盘后读文件计算并经 `applyRoundUpdate` 写回（见 `computePlanHash`）。
 *   hash 缺失时到达的回执一律挂起 `pending`（reason=`pending-hash`），
 *   绝不标 `superseded`（即使版本号也对不上）。
 * - `received`：同轮同人多次回执取最后一次（按成员键覆盖）。
 * - `superseded`：版本 ≠ 当前轮次版本的过期回执，仅归档备查，不触发修订。
 * - `status`：collecting（收集中）| complete（N/N 齐）| stale（超时转人工）。
 *
 * 并发规则：一切写走 `ReviewRoundService.applyRoundUpdate`（issues 行
 * `SELECT ... FOR UPDATE` 串行化）；合并规则为 received 按成员覆盖、
 * round/planVersion 只升不降。
 */

/** issue description 内机器段分隔符（逐字节固定，解析与落盘共用）。 */
export const REVIEW_ROUND_DELIMITER = '<!-- REVIEW-ROUND-JSON -->';

/** 账本 JSON Schema 版本（必填字段，解析时校验）。 */
export const REVIEW_ROUND_SCHEMA_VERSION = 1;

/** 轮次状态：收集中 / 已收敛 / 超时转人工。 */
export type ReviewRoundStatus = 'collecting' | 'complete' | 'stale';

/** 评审结论（复用冷评审 VERDICT 口径）。 */
export type ReviewVerdict = 'APPROVE' | 'REJECT';

/** 版本钉定：版本号 + 行数 + 落盘内容 sha1 前 8。 */
export interface PlanVersionRef {
  version: string;
  lines: number;
  hash: string;
}

/** 已计入轮次的单成员回执。 */
export interface RoundReceipt {
  verdict: ReviewVerdict;
  msgId: string;
  version: string;
}

/** 挂起回执：hash 缺失时暂存，待 hash 回填后由收敛门重裁。 */
export interface PendingReceipt extends RoundReceipt {
  member: string;
  reason: 'pending-hash';
}

/** 过期回执归档：版本 ≠ 当前轮次版本，仅备查。 */
export interface SupersededReceipt extends RoundReceipt {
  member: string;
}

/** 轮次账本（schemaVersion:1）。 */
export interface ReviewRoundLedger {
  schemaVersion: 1;
  round: number;
  planVersion: PlanVersionRef;
  planPath?: string;
  /** plan↔task 链接：账本所属任务。 */
  taskId?: string;
  /** plan↔issue 链接：宿主 issue（派发时写回，即 dispatch issue）。 */
  issueId?: string;
  /** 期望评审人（团队成员 id / tmm_）。 */
  expected: string[];
  expectedRoles?: string[];
  /** 已收回执（按成员键覆盖，同人多次取最后一次）。 */
  received: Record<string, RoundReceipt>;
  pending?: PendingReceipt[];
  superseded?: SupersededReceipt[];
  status: ReviewRoundStatus;
  timeoutAt: string;
}

/** 回执输入（applyRoundUpdate / resolveVerdict 共用）。 */
export interface VerdictInput {
  member: string;
  verdict: ReviewVerdict;
  msgId: string;
  /** 缺省表示"未引用版本号"（§3.3 应打回；账本层记为待定版本）。 */
  version?: string;
}

/** 账本增量更新（applyRoundUpdate 输入；received 可单条或多条）。 */
export interface RoundUpdate {
  round?: number;
  planVersion?: Partial<PlanVersionRef>;
  planPath?: string;
  taskId?: string;
  issueId?: string;
  expected?: string[];
  expectedRoles?: string[];
  received?: VerdictInput | VerdictInput[];
  status?: ReviewRoundStatus;
  timeoutAt?: string;
}

/** 账本域错误码（独立命名，不碰 issues.constants / task machine）。 */
export const REVIEW_ROUND_ERRORS = {
  /** 宿主 issue 不存在（404）。 */
  ISSUE_NOT_FOUND: 'REVIEW_ROUND_ISSUE_NOT_FOUND',
  /** 机器段 JSON 损坏（非空但解析/校验失败）。 */
  CORRUPT: 'REVIEW_ROUND_CORRUPT',
} as const;

/**
 * 计划内容 hash（planner-revise 落盘钩口径）：落盘后读文件全文，
 * 取 sha1 前 8 写回账本 `planVersion.hash`。不靠手写行数钉版本。
 */
export function computePlanHash(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 8);
}

/** 新建空轮次账本（status=collecting，received 为空）。 */
export function createLedger(init: {
  round?: number;
  planVersion?: Partial<PlanVersionRef>;
  planPath?: string;
  taskId?: string;
  issueId?: string;
  expected?: string[];
  expectedRoles?: string[];
  status?: ReviewRoundStatus;
  timeoutAt?: string;
}): ReviewRoundLedger {
  return {
    schemaVersion: REVIEW_ROUND_SCHEMA_VERSION,
    round: init.round ?? 1,
    planVersion: {
      version: init.planVersion?.version ?? 'v0.1',
      lines: init.planVersion?.lines ?? 0,
      hash: init.planVersion?.hash ?? '',
    },
    ...(init.planPath !== undefined ? { planPath: init.planPath } : {}),
    ...(init.taskId !== undefined ? { taskId: init.taskId } : {}),
    ...(init.issueId !== undefined ? { issueId: init.issueId } : {}),
    expected: [...(init.expected ?? [])],
    ...(init.expectedRoles !== undefined
      ? { expectedRoles: [...init.expectedRoles] }
      : {}),
    received: {},
    status: init.status ?? 'collecting',
    timeoutAt: init.timeoutAt ?? '',
  };
}

/**
 * 账本落盘：将账本序列化为机器段并嵌入 issue description。
 * 已有机器段则整体替换（幂等，文本区只保留一份机器段）。
 */
export function embedLedger(
  description: string | null | undefined,
  ledger: ReviewRoundLedger,
): string {
  const segment = `${REVIEW_ROUND_DELIMITER}\n\`\`\`json\n${JSON.stringify(ledger, null, 2)}\n\`\`\``;
  const text = description ?? '';
  const idx = text.indexOf(REVIEW_ROUND_DELIMITER);
  if (idx === -1) {
    return text ? `${text}\n\n${segment}\n` : `${segment}\n`;
  }
  const head = text.slice(0, idx).replace(/\s+$/, '');
  return head ? `${head}\n\n${segment}\n` : `${segment}\n`;
}

/** 账本读取：无机器段返回 null；机器段损坏抛 REVIEW_ROUND_CORRUPT。 */
export function parseLedger(
  description: string | null | undefined,
): ReviewRoundLedger | null {
  if (!description) return null;
  const idx = description.indexOf(REVIEW_ROUND_DELIMITER);
  if (idx === -1) return null;
  const tail = description.slice(idx + REVIEW_ROUND_DELIMITER.length);
  const match = /```json\s*([\s\S]*?)```/.exec(tail);
  if (!match) {
    throw new Error(REVIEW_ROUND_ERRORS.CORRUPT);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]) as unknown;
  } catch {
    throw new Error(REVIEW_ROUND_ERRORS.CORRUPT);
  }
  assertLedger(raw);
  return raw;
}

function assertLedger(raw: unknown): asserts raw is ReviewRoundLedger {
  const valid =
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { schemaVersion?: unknown }).schemaVersion ===
      REVIEW_ROUND_SCHEMA_VERSION &&
    typeof (raw as { round?: unknown }).round === 'number' &&
    typeof (raw as { planVersion?: unknown }).planVersion === 'object' &&
    (raw as { planVersion?: unknown }).planVersion !== null &&
    Array.isArray((raw as { expected?: unknown }).expected) &&
    typeof (raw as { received?: unknown }).received === 'object' &&
    (raw as { received?: unknown }).received !== null &&
    typeof (raw as { status?: unknown }).status === 'string' &&
    typeof (raw as { timeoutAt?: unknown }).timeoutAt === 'string';
  if (!valid) {
    throw new Error(REVIEW_ROUND_ERRORS.CORRUPT);
  }
}

/** 版本号比较（vN 数字优先，否则字典序；缺省视为最低）。 */
function comparePlanVersion(a: string, b: string): number {
  const na = /^v(\d+)$/.exec(a.trim());
  const nb = /^v(\d+)$/.exec(b.trim());
  if (na && nb) return Number(na[1]) - Number(nb[1]);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function mergePlanVersion(
  base: PlanVersionRef,
  patch: Partial<PlanVersionRef> | undefined,
): PlanVersionRef {
  if (!patch || patch.version === undefined) {
    return { ...base, ...patch };
  }
  // version 只升不降：低版本打回整体保留基线。
  if (comparePlanVersion(patch.version, base.version) < 0) {
    return { ...base };
  }
  return { ...base, ...patch };
}

/**
 * 账本合并（并发合并规则）：
 * - received 按成员覆盖（调用方应先经 `resolveVerdict` 裁决；
 *   本函数对直接传入的 received 条目同样按成员键覆盖）；
 * - round 只升不降；升轮时 received/pending/superseded 清零（新轮次重新收集，
 *   旧轮次明细随 issue_activities / 历史 description 可审计）；
 * - planVersion.version 只升不降；
 * - expected/expectedRoles/status/timeoutAt/planPath/taskId/issueId 有值则覆盖。
 */
export function mergeLedger(
  base: ReviewRoundLedger,
  update: RoundUpdate,
): ReviewRoundLedger {
  const round =
    update.round !== undefined ? Math.max(base.round, update.round) : base.round;
  const roundAdvanced = round > base.round;
  const receivedInputs =
    update.received === undefined
      ? []
      : Array.isArray(update.received)
        ? update.received
        : [update.received];
  const received: Record<string, RoundReceipt> = roundAdvanced
    ? {}
    : { ...base.received };
  for (const v of receivedInputs) {
    received[v.member] = {
      verdict: v.verdict,
      msgId: v.msgId,
      version: v.version ?? '',
    };
  }
  return {
    schemaVersion: REVIEW_ROUND_SCHEMA_VERSION,
    round,
    planVersion: mergePlanVersion(base.planVersion, update.planVersion),
    ...(update.planPath !== undefined
      ? { planPath: update.planPath }
      : base.planPath !== undefined
        ? { planPath: base.planPath }
        : {}),
    ...(update.taskId !== undefined
      ? { taskId: update.taskId }
      : base.taskId !== undefined
        ? { taskId: base.taskId }
        : {}),
    ...(update.issueId !== undefined
      ? { issueId: update.issueId }
      : base.issueId !== undefined
        ? { issueId: base.issueId }
        : {}),
    expected: update.expected !== undefined ? [...update.expected] : [...base.expected],
    ...(update.expectedRoles !== undefined
      ? { expectedRoles: [...update.expectedRoles] }
      : base.expectedRoles !== undefined
        ? { expectedRoles: [...base.expectedRoles] }
        : {}),
    received,
    ...(!roundAdvanced && base.pending !== undefined ? { pending: [...base.pending] } : {}),
    ...(!roundAdvanced && base.superseded !== undefined
      ? { superseded: [...base.superseded] }
      : {}),
    status: update.status ?? base.status,
    timeoutAt: update.timeoutAt ?? base.timeoutAt,
  };
}

export type VerdictOutcome = 'received' | 'pending-hash' | 'superseded';

/**
 * 回执裁决（docs 33 §3.3；hash 缺失分支为 todo 6 验收项）：
 * 1. `planVersion.hash` 缺失 → `pending-hash`：记入 `pending`，绝不标 superseded；
 * 2. 版本 ≠ 当前轮次版本 → `superseded`：记入 `superseded` 归档，不计入 received；
 * 3. 版本相符 → `received`：按成员覆盖（同人多次取最后一次）。
 */
export function resolveVerdict(
  ledger: ReviewRoundLedger,
  input: VerdictInput,
): { outcome: VerdictOutcome; ledger: ReviewRoundLedger } {
  if (!ledger.planVersion.hash) {
    const pending = [...(ledger.pending ?? [])].filter(
      (p) => !(p.member === input.member && p.msgId === input.msgId),
    );
    pending.push({
      member: input.member,
      verdict: input.verdict,
      msgId: input.msgId,
      version: input.version ?? '',
      reason: 'pending-hash',
    });
    return {
      outcome: 'pending-hash',
      ledger: { ...ledger, pending },
    };
  }
  const stated = (input.version ?? '').trim();
  if (stated !== ledger.planVersion.version) {
    const superseded = [...(ledger.superseded ?? [])].filter(
      (s) => !(s.member === input.member && s.msgId === input.msgId),
    );
    superseded.push({
      member: input.member,
      verdict: input.verdict,
      msgId: input.msgId,
      version: stated,
    });
    return { outcome: 'superseded', ledger: { ...ledger, superseded } };
  }
  return {
    outcome: 'received',
    ledger: {
      ...ledger,
      received: {
        ...ledger.received,
        [input.member]: {
          verdict: input.verdict,
          msgId: input.msgId,
          version: stated,
        },
      },
    },
  };
}
