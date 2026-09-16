import { parseLedger } from './review-round-ledger';

/**
 * 执行认哈希门禁纯函数（plan-finalize-actions todo 3；docs 33 §6.4 裁决一）。
 *
 * 门禁比对 `planVersion.hash`（triplet sha1-8，todo 1 裁决，禁止新算法）：
 * 调用方携带哈希（实际）vs 冻结正式版哈希（期望），不一致即过期拦截。
 *
 * 武装规则（只松不紧）：任一侧缺失 → 门禁未武装，调用方按原状态门禁语义
 * 放行，绝不因哈希新增限制（force 口径沿 todo 1 裁决：force+原因可绕并留审计）。
 *
 * 冻结哈希来源（todo 2 落 `frozenHash` 列前过渡口径）：任务下各轮次账本取
 * 最大 round 者 `planVersion.hash`——定稿后修订必走小循环并开新轮次，
 * 故最大轮次哈希即当前冻结正式版哈希。
 */

/** 调用方携带哈希归一化：trim；空串/非字符串一律按"未携带"处理（不收紧）。 */
export function normalizePlanHash(input: unknown): string | null {
  if (typeof input !== 'string') {
    return null;
  }
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

/**
 * 双哈希齐备且不一致即过期。任一缺失 → false（fail-open，保持原放行面）。
 */
export function isStalePlanHash(
  expected: string | null | undefined,
  actual: string | null | undefined,
): boolean {
  if (!expected || !actual) {
    return false;
  }
  return expected !== actual;
}

/**
 * 过期拦截精确 hint（逐字锁定：单测断言全等，改一字即红）。
 * 必须同时命名期望/实际短哈希（todo 3 验收：提示期望/实际短哈希）。
 */
export function buildStalePlanHashHint(
  expected: string,
  actual: string,
): string {
  return `计划哈希已过期：期望 #${expected}（冻结正式版），实际 #${actual}（请求携带）；请基于冻结版重新确认后携带新哈希重派`;
}

/**
 * 取任务冻结哈希代理：各轮次账本（issue description 机器段）取最大 round 者
 * `planVersion.hash`。无账本/机器段损坏/最新轮次 hash 为空（pending-hash 态）
 * → null（门禁未武装，fail-open）。本函数永不抛错。
 */
export function selectFrozenPlanHash(
  descriptions: Array<string | null | undefined>,
): string | null {
  let bestRound = -1;
  let bestHash: string | null = null;
  for (const description of descriptions) {
    let ledger: { round?: unknown; planVersion?: { hash?: unknown } } | null =
      null;
    try {
      ledger = parseLedger(description);
    } catch {
      continue;
    }
    if (!ledger || typeof ledger.round !== 'number') {
      continue;
    }
    if (ledger.round < bestRound) {
      continue;
    }
    const hash = (ledger.planVersion as { hash?: unknown } | undefined)?.hash;
    if (ledger.round > bestRound) {
      bestRound = ledger.round;
      bestHash = typeof hash === 'string' && hash ? hash : null;
    }
    // 同轮次并列 → 先到先得（落盘幂等替换，内容一致），保持稳定。
  }
  return bestHash;
}
