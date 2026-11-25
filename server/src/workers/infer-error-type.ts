/**
 * 错误类型推断（前端分类 + 判死尸检复用）。
 * 提取自 worker-event.ingress.ts 私有方法，保持两处语义一致。
 * 返回值对齐前端 msg-error kind 映射：auth_failed/quota_exceeded → quota(红)，model_busy → retry(琥珀)，
 * model_not_found → failed(红，确定性配置错误，重试无意义)，其余 model_error
 */
export function inferErrorType(error?: string): string {
  const e = (error ?? '').toLowerCase();
  if (/invalid api key|unauthorized|401|credential/.test(e))
    return 'auth_failed';
  // usage limit / plan limit 也是额度类（2026-11-25：上游「You've reached your weekly
  // usage limit for your plan」原本落到 model_error，被当成可重试的抖动 → 自动继续
  // 会连续烧掉额度。归到 quota_exceeded 后属于不可自动重试）。
  if (/quota|insufficient|billing|usage limit|plan limit|exceeded your/.test(e))
    return 'quota_exceeded';
  if (/model not found|provider.*not found|did you mean/.test(e))
    return 'model_not_found';
  if (/timeout|model_busy|busy|rate.?limit|overloaded|try again/.test(e))
    return 'model_busy';
  return 'model_error';
}

export function isQuotaError(errorType: string): boolean {
  return errorType === 'quota_exceeded' || errorType === 'auth_failed';
}

export function isTransientError(errorType: string): boolean {
  return errorType === 'model_busy' || errorType === 'model_error';
}
