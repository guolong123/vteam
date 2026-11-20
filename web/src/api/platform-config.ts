/**
 * 平台配置 API 封装（会话上下文压缩等运行期可调参数）。
 *
 * 对齐 server/src/platform-config：
 * - GET /platform-configs：全量列表（含默认值兜底）
 * - GET /platform-configs/:key：单项
 * - PATCH /platform-configs/:key：改单项（值校验失败 → 400）
 * - PATCH /platform-configs：批量改（单事务，任一非法 → 整体回滚）
 *
 * 仅平台管理员可读写（AdminGuard）；所有方法经 web/lib/api 统一鉴权与错误归一。
 */
import { api } from "@/lib/api";

export type PlatformConfigValueType = "number" | "bool" | "string";

/** 单条平台配置（含默认值兜底与解析后的生效值）。 */
export interface PlatformConfigDto {
  key: string;
  value: string;
  valueType: PlatformConfigValueType;
  description: string;
  /** 解析后的生效值（number/bool 按类型解析，失败回落字符串）。 */
  effectiveValue: number | boolean | string;
  updatedBy: string | null;
  updatedAt: string;
}

/** 平台配置 API。 */
export const platformConfigApi = {
  /** 全量配置列表。 */
  list: () => api.get<PlatformConfigDto[]>("/platform-configs"),

  /** 单项配置。 */
  get: (key: string) =>
    api.get<PlatformConfigDto>(`/platform-configs/${encodeURIComponent(key)}`),

  /** 更新单项（value 为字符串形态；服务端按该键类型校验）。 */
  updateOne: (key: string, value: string) =>
    api.patch<PlatformConfigDto>(
      `/platform-configs/${encodeURIComponent(key)}`,
      { value },
    ),

  /** 批量更新（单事务，任一非法 → 整体回滚）。 */
  updateMany: (configs: Record<string, string>) =>
    api.patch<PlatformConfigDto[]>("/platform-configs", { configs }),
};

/** 会话压缩的四个配置键（界面分区用）。 */
export const SESSION_COMPACT_KEYS = {
  idleDays: "SESSION_COMPACT_IDLE_DAYS",
  minContextTokens: "SESSION_COMPACT_MIN_CONTEXT_TOKENS",
  awaitMs: "SESSION_COMPACT_AWAIT_MS",
  timeoutMs: "SESSION_COMPACT_TIMEOUT_MS",
} as const;
