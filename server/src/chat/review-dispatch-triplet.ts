/**
 * 评审派发三元组模板（plan-review-execution-gates todo 8，docs 33 §3.2/§3.5）。
 *
 * PM 派评审必须携带 `round + planVersion(+hash) + expected 名单` 三元组
 * （沿 m_482/484/486 派发词体例并追加三元组段）；缺三元组的派发视为无效派发，
 * 计划员侧校验拒绝并返回精确 hint，修订不开始。
 * 派发词须写死视角边界：架构=方案/边界/状态机，
 * 开发=可执行性/依赖/工作量，测试=覆盖/判据可执行性（docs 33 §3.5）。
 *
 * 纯函数模块（无依赖、确定性）：解析 + 校验 + footer 拼装，
 * 真正的拒绝动作只落在 notifyAgent 一处 choke 点（本文件永不写库、不触发分派）。
 */

/** 计划员侧退回话术（逐字锁定：单测断言全等，改一字即红）。 */
export const REVIEW_TRIPLET_HINT =
  '评审派发缺三元组：须携带 round + planVersion(+hash) + expected 名单（例：R2 · v0.3#abcd1234 · expected: tmm_aaa,tmm_bbb）；本次派发已拒绝触发，修订不得开始，补齐三元组后重派';

/** 视角边界（docs 33 §3.5：评审人不跨视角展开，S1 式重复由 PM 汇总去重）。 */
export const ROLE_VIEW_BOUNDARIES = {
  architect: '方案/边界/状态机',
  developer: '可执行性/依赖/工作量',
  tester: '覆盖/判据可执行性',
} as const;

/** 派发词视角边界段（放行派发缺此段时由 choke 点追加写入）。 */
export const ROLE_VIEW_FOOTER = `视角边界：架构=${ROLE_VIEW_BOUNDARIES.architect}；开发=${ROLE_VIEW_BOUNDARIES.developer}；测试=${ROLE_VIEW_BOUNDARIES.tester}`;

/** 三元组缺失项（hint 保持精确固定，缺失明细仅告警日志/单测断言用）。 */
export type TripletMissing = 'round' | 'planVersion' | 'planHash' | 'expected';

/** 解析出的三元组（planHash 为计划文件落盘 sha1 前 8，todo 6 口径）。 */
export interface ReviewDispatchTriplet {
  round: number;
  planVersion: string;
  planHash: string;
  expected: string[];
}

/**
 * 解析结果（单接口 + 可选字段：与 parseLedger 可空口径一致，
 * 本仓库 strictNullChecks 关闭，判别联合在单测编译下不收窄，勿用联合）。
 */
export interface TripletParseResult {
  ok: boolean;
  triplet?: ReviewDispatchTriplet;
  missing?: TripletMissing[];
}

const ROUND_RE = /(?:^|[^\w])R(\d+)\b|round\s*[:：#]?\s*(\d+)/i;
const VERSION_RE = /v(\d+(?:\.\d+)?)/i;
const HASH_RE = /#([0-9a-f]{8})\b|hash\s*[:：]?\s*([0-9a-f]{8})/i;
const EXPECTED_RE = /expected\s*[:：]\s*([^\n]+)/i;
const MEMBER_RE = /tmm_[A-Za-z0-9_]+/g;

/**
 * 派发词三元组解析：
 * - round：`R<数字>` 或 `round <数字>`；
 * - planVersion：`v<数字>[.<数字>]`；
 * - planHash：`#<8位hex>` 或 `hash <8位hex>`（版本钉定，缺 hash 即缺三元组）；
 * - expected：`expected:` 后名单内至少一个 `tmm_` 成员 id。
 */
export function parseReviewTriplet(
  content: string | null | undefined,
): TripletParseResult {
  const text = content ?? '';
  const missing: TripletMissing[] = [];

  const roundMatch = ROUND_RE.exec(text);
  const roundRaw = roundMatch?.[1] ?? roundMatch?.[2];
  if (roundRaw === undefined) {
    missing.push('round');
  }
  const versionMatch = VERSION_RE.exec(text);
  if (!versionMatch) {
    missing.push('planVersion');
  }
  const hashMatch = HASH_RE.exec(text);
  if (!hashMatch) {
    missing.push('planHash');
  }
  const expectedMatch = EXPECTED_RE.exec(text);
  const members = expectedMatch?.[1]?.match(MEMBER_RE) ?? [];
  if (members.length === 0) {
    missing.push('expected');
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    triplet: {
      round: Number(roundRaw),
      planVersion: `v${versionMatch?.[1] as string}`,
      planHash: (hashMatch?.[1] ?? hashMatch?.[2]) as string,
      expected: members,
    },
  };
}

/**
 * 放行派发词嵌入视角边界：缺 `视角边界` 段则追加 footer，已有则原样返回（幂等）。
 */
export function ensureRoleViewFooter(text: string): string {
  if (text.includes(ROLE_VIEW_FOOTER)) {
    return text;
  }
  return `${text}\n${ROLE_VIEW_FOOTER}`;
}
