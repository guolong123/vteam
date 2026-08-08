/**
 * 统一 API 错误。对齐设计文档 09 篇 §2 错误响应格式：
 * `{ code, message, details? }`，其中 code 为业务错误码（如 AUTH_*、
 * VALIDATION_*、TASK_INVALID_TRANSITION 等），HTTP 状态码见 09 篇 §2.1。
 */
export class ApiError extends Error {
  /** HTTP 状态码；网络层失败时为 0。 */
  status: number;
  /** 业务错误码，如 "AUTH_TOKEN_EXPIRED"。 */
  code: string;
  /** 附加错误细节（可选）。 */
  details?: unknown;

  constructor(
    status: number,
    body: { code: string; message: string; details?: unknown }
  ) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

/** 类型守卫：判断未知对象是否为 ApiError。 */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}