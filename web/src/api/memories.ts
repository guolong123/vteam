/**
 * 记忆 API 封装（记忆域）
 * =============================================
 * 对齐 server/src/memories：GET /memories 分页检索（level / teamId / roleId /
 * archived / keyword / page / pageSize）、PATCH /memories/:id（autoInject）、
 * DELETE /memories/:id（**软删 = 归档**）、POST /memories/:id/restore（恢复）、
 * POST /memories/:id/purge（**硬删，不可恢复**）。
 * 所有方法经 web/lib/api 统一鉴权与错误归一。
 */
import { api } from "@/lib/api";

/** 记忆级别（任务级记忆已下线，后端 level=task → 400 MEMORY_LEVEL_INVALID）。 */
export type MemoryLevel = "team" | "role" | "global";

/** GET /memories 条目（对齐 MemoriesService.findAll 返回的完整行）。 */
export interface MemoryItem {
  id: string;
  level: MemoryLevel;
  content: string;
  description?: string | null;
  tags: string[] | null;
  createdBy: string;
  createdAt: string;
  /** 是否参与每轮自动注入（单条记忆属性；false = 仅 memory_search 按需检索）。 */
  autoInject: boolean;
  /** 角色级记忆的归属岗位（ar_ 前缀 → AgentRole.id）；仅 level=role 时非空。 */
  roleId?: string | null;
  teamId?: string | null;
  /**
   * 写入来源（agent|user|system）。与 `createdBy` 的 id 形态一起决定创建者展示：
   * seed 出来的团队章程是 `system` + `u_` 用户 id，压根不是团队成员。
   */
  sourceType?: string | null;
  /** 被检索/注入命中次数（重要度排序指标；老行为 0）。 */
  refCount: number;
  /** 最近一次被检索命中的时间；从未命中为 null。 */
  lastUsedAt?: string | null;
  /** 语义重复合并后的目标记忆 id；非空 = 本行已并入该行（软删 + 只读标记）。 */
  mergedIntoId?: string | null;
}

/** GET /memories 分页响应。 */
export interface MemoriesResponse {
  items: MemoryItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /memories 检索参数。undefined 键由 api 层自动从 query string 省略。 */
export type MemoriesListParams = {
  level?: MemoryLevel | "";
  teamId?: string;
  roleId?: string;
  /** 三态筛选：true = 仅已归档，false = 仅活跃，undefined = 不过滤。 */
  archived?: boolean;
  keyword?: string;
  page?: number;
  pageSize?: number;
};

/**
 * 记忆列表共享查询键（对齐 TeamRightPanel 的 triggersQueryKey 导出模式）：
 * 管理页与团队记忆 tab 共用同一 key 形状，invalidateQueries({queryKey:["memories"]})
 * 前缀失效对两者同时生效。
 */
export function memoriesQueryKey(
  params: MemoriesListParams
): [string, MemoriesListParams] {
  return ["memories", params];
}

export const memoriesApi = {
  /** 分页检索记忆。 */
  list(params: MemoriesListParams): Promise<MemoriesResponse> {
    return api.get<MemoriesResponse>("/memories", {
      query: params as Record<string, string | number | boolean | undefined>,
    });
  },
  /**
   * 归档记忆（DELETE /memories/:id）。
   * 注意：这是**软删**——写 deletedAt，GET 列表默认不可见，可经 restore 恢复；
   * 不可恢复的物理删除走 purge。
   */
  archive(id: string): Promise<MemoryItem> {
    return api.delete<MemoryItem>(`/memories/${id}`);
  },
  /** 恢复已归档记忆；撞活跃同 hash → 409。 */
  restore(id: string): Promise<MemoryItem> {
    return api.post<MemoryItem>(`/memories/${id}/restore`);
  },
  /** 永久删除（硬删，行彻底消失，不可恢复）。 */
  purge(id: string): Promise<MemoryItem> {
    return api.post<MemoryItem>(`/memories/${id}/purge`);
  },
  /** 切换单条记忆的自动注入开关。 */
  setAutoInject(id: string, autoInject: boolean): Promise<MemoryItem> {
    return api.patch<MemoryItem>(`/memories/${id}`, { autoInject });
  },
};