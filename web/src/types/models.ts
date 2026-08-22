/**
 * 共享前端类型：模型目录与可用模型契约（C3/C6）
 * =============================================
 * - AvailableModel：GET /agents/:id/available-models 条目（C3 改读目录，
 *   id=providerID/modelID 格式，name=产品视角名；worker pull 兜底 / STATIC fallback 同构）。
 * - ApiModel / ModelsResponse / ApiWorker / CredentialView / ProviderSummary：
 *   模型管理页与 Provider 管理页共享的 API 契约（C3/C4/C5），从 models/page.tsx
 *   页面私有定义提取。
 */

/** GET /agents/:id/available-models 条目（FR-47，C3 目录读取）。 */
export interface AvailableModel {
  /** 模型 id：providerID/modelID（与 STATIC_AVAILABLE_MODELS 同格式） */
  id: string;
  /** 产品视角模型名（展示列） */
  name: string;
}

/** GET /models 条目（Model 表行，id=md_xxx 目录行 id）。 */
export interface ApiModel {
  id: string;
  providerID: string;
  modelID: string;
  name: string;
  enabled: boolean;
  baseUrl?: string | null;
  providerType?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /models 分页响应（对齐 mcp-servers/tools findAll 模式）。 */
export interface ModelsResponse {
  items: ApiModel[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /workers 条目（toWorkerView；capabilities.models 为 C2 上报模型 id 数组）。 */
export interface ApiWorker {
  id: string;
  name: string | null;
  status: string;
  capabilities: { models?: string[] } | null;
}

/** GET /models/:id/credentials（脱敏视图，绝无明文 token）。 */
export interface CredentialView {
  id: string;
  providerID: string;
  configured: boolean;
  fingerprint: string | null;
  revokedAt: string | null;
  createdAt: string | null;
}

/**
 * GET /models/providers 条目（Provider 聚合：模型数 + 凭据状态，成员只读）。
 * 一次请求替代「GET /models 全量分组 + 逐 provider 查凭据」前端聚合（C9 后端端点）。
 */
export interface ProviderSummary {
  /** 模型归属 provider（models 表 groupBy 聚合） */
  providerID: string;
  /** enabled 模型数 */
  modelCount: number;
  /** 凭据存在且未吊销 */
  configured: boolean;
  /** 已脱敏指纹（未配置/已吊销时为 null，明文零接触） */
  fingerprint: string | null;
  /** 吊销时间（未吊销为 null） */
  revokedAt: string | null;
  providerType?: string | null;
  baseUrl?: string | null;
}
