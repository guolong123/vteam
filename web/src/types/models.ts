/**
 * 共享前端类型：模型目录与可用模型契约（C3/C6）
 * =============================================
 * - AvailableModel：GET /agents/:id/available-models 条目（C3 改读目录，
 *   id=providerID/modelID 格式，name=产品视角名；worker pull 兜底 / STATIC fallback 同构）。
 * - 原 agents/page.tsx 页面私有定义提取为共享（agents 页 + 模型管理页复用）。
 */

/** GET /agents/:id/available-models 条目（FR-47，C3 目录读取）。 */
export interface AvailableModel {
  /** 模型 id：providerID/modelID（与 STATIC_AVAILABLE_MODELS 同格式） */
  id: string;
  /** 产品视角模型名（展示列） */
  name: string;
}
