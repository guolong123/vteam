/**
 * 错误类型推断（前端分类 + 判死尸检复用）。
 * 提取自 worker-event.ingress.ts 私有方法，保持两处语义一致。
 * 返回值对齐前端 msg-error kind 映射：auth_failed/quota_exceeded → quota(红)，model_busy → retry(琥珀)，其余 model_error
 */
export function inferErrorType(error?: string): string {
  const e = (error ?? '').toLowerCase();
  if (/invalid api key|unauthorized|401|credential/.test(e)) return 'auth_failed';
  if (/quota|insufficient|billing/.test(e)) return 'quota_exceeded';
  if (/timeout|model_busy|busy|rate.?limit|overloaded|try again/.test(e)) return 'model_busy';
  return 'model_error';
}

export function isQuotaError(errorType: string): boolean {
  return errorType === 'quota_exceeded' || errorType === 'auth_failed';
}

export function isTransientError(errorType: string): boolean {
  return errorType === 'model_busy' || errorType === 'model_error';
}
