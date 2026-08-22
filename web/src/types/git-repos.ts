/**
 * 共享前端类型：git 仓库凭证与授权契约（17 篇《仓库权限与凭证机制》）
 * =============================================
 * - GitRepoView / GitGrantView：GET /git-repos 条目（脱敏视图，响应绝无
 *   credentialRef/key 明文，只有 fingerprint）。
 * - CreateGitRepoPayload / UpdateGitRepoPayload：POST / PATCH /git-repos 请求体。
 * - ApiAgent / AgentsResponse：GET /agents 条目最小字段（配置弹窗授权多选数据源；
 *   对齐 agents 页 AgentItem 的 id/name/role 三字段，避免页面间重复定义）。
 */

/** GET /git-repos 授权条目（join GitRepoGrant 未吊销 + Agent.name）。 */
export interface GitGrantView {
  /** 授权 agent id（TaskAgent 实例） */
  agentId: string;
  /** 授权 agent 名（join Agent；查不到为 null） */
  name: string | null;
  /** 权限：read=只读（clone/pull/fetch/status/diff/log）/ write=含 push */
  permission: "read" | "write";
  /** 生效方式：allow=直接允许 / ask=需成员确认（写操作为 ask） */
  effect: "allow" | "ask";
}

/** GET /git-credentials 条目（脱敏视图，凭证池）。 */
export interface GitCredentialView {
  id: string;
  name: string;
  authType: "ssh_key" | "https_token";
  fingerprint: string | null;
  description: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** POST /git-credentials 请求体 */
export interface CreateGitCredentialPayload {
  name: string;
  authType: "ssh_key" | "https_token";
  key: string;
  description?: string;
}

/** PATCH /git-credentials/:id 请求体 */
export interface UpdateGitCredentialPayload {
  name?: string;
  key?: string;
  description?: string;
}

/** GET /git-repos 条目（脱敏视图：通过 credentialId 关联凭证，含 credentialName/authType/fingerprint）。 */
export interface GitRepoView {
  id: string;
  repoUrl: string;
  credentialId: string;
  credentialName: string | null;
  authType: "ssh_key" | "https_token";
  fingerprint: string | null;
  revokedAt: string | null;
  grantedAgents: GitGrantView[];
  createdAt: string;
}

/** 授权输入条目（POST/PATCH 共用）。 */
export interface GitGrantInput {
  agentId: string;
  permission: "read" | "write";
  effect: "allow" | "ask";
}

/** POST /git-repos 请求体（credentialId 指向已创建凭证）。 */
export interface CreateGitRepoPayload {
  repoUrl: string;
  credentialId: string;
  grantedAgents?: GitGrantInput[];
}

/** PATCH /git-repos/:id 请求体（切换凭证或更新授权）。 */
export interface UpdateGitRepoPayload {
  credentialId?: string;
  grantedAgents?: GitGrantInput[];
}

/** GET /agents 条目最小字段（授权多选数据源；对齐 agents 页 AgentItem）。 */
export interface ApiAgent {
  id: string;
  name: string;
  role: string | null;
}

/** GET /agents 分页响应（agents/skills/tools 同构）。 */
export interface AgentsResponse {
  items: ApiAgent[];
  total: number;
  page: number;
  pageSize: number;
}
