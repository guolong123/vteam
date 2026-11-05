import { ApiError } from "./errors";

/**
 * 统一 API 基础路径。默认对齐设计文档 09 篇 §2：`/api/v1`。
 * 可通过环境变量 NEXT_PUBLIC_API_BASE_URL 覆盖（如部署到独立后端域名时）。
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "/api/v1";

/**
 * 当前访问令牌（access token）。由 authStore 在登录/登出/水合时同步。
 * 使用模块级变量持有，避免每次请求都去读 localStorage（SSR 安全）。
 */
let accessToken: string | null = null;

/** 同步 token 到 api 层（authStore 调用）。 */
export function setAuthToken(token: string | null): void {
  accessToken = token;
}

/** 读取当前 token，供需要的场景（如 SSE 鉴权参数）使用。 */
export function getAuthToken(): string | null {
  return accessToken;
}

/**
 * 401 全局处理（token 失效 → 清 auth + 跳登录）。
 * 用 handler 注册解耦，避免循环依赖：api 不 import authStore，
 * 由 authStore 在模块加载时通过本函数挂载回调。
 */
let unauthorizedHandler: (() => void) | null = null;

/** 注册 401 处理器（authStore 调用；传 null 可注销）。 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/**
 * 刷新处理器（续期链路的核心接缝）。
 * api 层不 import authStore（避免循环依赖），由 authStore 注册：
 * - 返回新的 accessToken（内部会调 POST /auth/refresh 并写回 store）
 * - refreshToken 失效（服务端 401 AUTH_REFRESH_INVALID）时返回 `null`
 *   ⇒ api 层据此判定「真的没救了」才触发 unauthorizedHandler（登出跳登录）
 * - 并发安全由 authStore 保证单飞（多个请求同时 401 只发一次 refresh）
 */
type RefreshHandler = () => Promise<string | null>;

let refreshHandler: RefreshHandler | null = null;

/** 注册刷新处理器（authStore 调用；传 null 可注销）。 */
export function setRefreshHandler(handler: RefreshHandler | null): void {
  refreshHandler = handler;
}

/** 这些路径的 401 属于「凭证本身错误」，绝不能触发续期（否则死循环）。 */
const NO_REFRESH_PATHS = ['/auth/login', '/auth/refresh', '/auth/register'];

function isRefreshablePath(path: string): boolean {
  return !NO_REFRESH_PATHS.some((p) => path.startsWith(p));
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** 请求体，自动 JSON 序列化。传 undefined 则不带 body。 */
  body?: unknown;
  /** 查询参数，自动拼接为 URL query string。值为 undefined 的键会被忽略。 */
  query?: Record<string, string | number | boolean | undefined>;
  /** 成功响应解析方式。默认 JSON；纯文本端点显式传 text。 */
  parse?: "json" | "text";
}

/**
 * 统一 fetch 封装：
 * - 自动拼接 baseURL 与 query
 * - 自动注入 `Authorization: Bearer <token>`
 * - 统一错误归一化（对齐 09 篇 §2 错误响应 `{code, message, details?}`）
 */
export async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { body, query, headers, parse = "json", ...rest } = options;

  let url = `${API_BASE_URL}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    const qs = params.toString();
    if (qs) {
      url += `${url.includes("?") ? "&" : "?"}${qs}`;
    }
  }

  // multipart：FormData 不 JSON 序列化，且不设 Content-Type
  // （浏览器自动携带 multipart/form-data; boundary=...，手设会导致 boundary 丢失 400）
  const isFormData = body instanceof FormData;

  /** 按当前 accessToken 组装请求头（续期后重试需重新取值）。 */
  const buildHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      ...(headers as Record<string, string> | undefined),
    };
    if (accessToken) {
      h.Authorization = `Bearer ${accessToken}`;
    }
    if (isFormData) {
      delete h["Content-Type"];
    }
    return h;
  };

  const doFetch = async (): Promise<Response> => {
    try {
      return await fetch(url, {
        ...rest,
        headers: buildHeaders(),
        body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // 网络层失败（断网 / CORS / 后端不可达）
      throw new ApiError(0, {
        code: "NETWORK_ERROR",
        message:
          err instanceof Error ? err.message : "网络请求失败，请检查连接",
      });
    }
  };

  let resp = await doFetch();

  /**
   * 401 自动续期（保证「记住我」下 1 周内不用重新登录）：
   * accessToken 默认只有 2h，到期后所有接口都会 401。此前实现是**直接登出跳登录页**，
   * 用户表现为「登录后很短时间就被踢出」。现在的处理：
   * 1. 首次 401 + 该端点不是登录/刷新本身 → 调 refreshHandler（内部单飞 POST /auth/refresh，
   *    成功则把新 accessToken 写回 store 与本模块）；
   * 2. 拿到新 token → **原请求自动重试一次**（用户完全无感，表单/上传等 POST 也照样重放；
   *    FormData 未被消费，可安全重发）；
   * 3. 刷新失败（refreshToken 也过期/账号被禁用）→ 才走 unauthorizedHandler（清登录态跳登录）。
   * 只重试一次，避免 refresh 端点异常时的无限循环。
   */
  if (
    resp.status === 401 &&
    accessToken &&
    refreshHandler &&
    isRefreshablePath(path)
  ) {
    const renewed = await refreshHandler();
    if (renewed) {
      accessToken = renewed;
      resp = await doFetch();
    }
  }

  if (!resp.ok) {
    // 401 且请求携带 token（登录/注册等 Public 无 token 的 401 如密码错误不触发，
    // 或续期也失败）：token 真的失效 → 由已注册 handler 清登录态并跳登录页
    if (resp.status === 401 && accessToken) {
      unauthorizedHandler?.();
    }
    let parsed: { code?: string; message?: string | string[]; details?: unknown } = {};
    try {
      parsed = (await resp.json()) as typeof parsed;
    } catch {
      // 响应体非 JSON（如网关 502 的 HTML），保持默认错误
    }
    // class-validator 校验失败的 message 是数组（如 ["token 不能为空"]），拼接为可读文案
    const rawMessage = parsed.message;
    const messageText = Array.isArray(rawMessage)
      ? rawMessage.join("；")
      : rawMessage;
    throw new ApiError(resp.status, {
      code: typeof parsed.code === "string" ? parsed.code : "INTERNAL_ERROR",
      message:
        typeof messageText === "string"
          ? messageText
          : `请求失败 (HTTP ${resp.status})`,
      details: parsed.details,
    });
  }

  if (resp.status === 204) {
    return undefined as T;
  }
  const text = await resp.text();
  // DELETE 等端点可能返回 200 空 body（NestJS 对 undefined 返回序列化空响应体）——
  // 空 body 按成功处理返回 undefined，避免 JSON.parse('') 抛错导致误判失败
  if (!text) {
    return undefined as T;
  }
  if (parse === "text") {
    return text as T;
  }
  return JSON.parse(text) as T;
}

/** 便捷方法：GET / POST / PATCH / DELETE。 */
export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "PATCH", body }),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: "DELETE" }),
};