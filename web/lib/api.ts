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

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** 请求体，自动 JSON 序列化。传 undefined 则不带 body。 */
  body?: unknown;
  /** 查询参数，自动拼接为 URL query string。值为 undefined 的键会被忽略。 */
  query?: Record<string, string | number | boolean | undefined>;
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
  const { body, query, headers, ...rest } = options;

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

  const finalHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(headers as Record<string, string> | undefined),
  };
  if (accessToken) {
    finalHeaders.Authorization = `Bearer ${accessToken}`;
  }
  // multipart：FormData 不 JSON 序列化，且不设 Content-Type
  // （浏览器自动携带 multipart/form-data; boundary=...，手设会导致 boundary 丢失 400）
  const isFormData = body instanceof FormData;
  if (isFormData) {
    delete finalHeaders["Content-Type"];
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      ...rest,
      headers: finalHeaders,
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

  if (!resp.ok) {
    let parsed: { code?: string; message?: string; details?: unknown } = {};
    try {
      parsed = (await resp.json()) as typeof parsed;
    } catch {
      // 响应体非 JSON（如网关 502 的 HTML），保持默认错误
    }
    throw new ApiError(resp.status, {
      code: typeof parsed.code === "string" ? parsed.code : "INTERNAL_ERROR",
      message:
        typeof parsed.message === "string"
          ? parsed.message
          : `请求失败 (HTTP ${resp.status})`,
      details: parsed.details,
    });
  }

  if (resp.status === 204) {
    return undefined as T;
  }
  return (await resp.json()) as T;
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