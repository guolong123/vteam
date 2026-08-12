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

/** GET /git-repos 条目（脱敏视图：只含 fingerprint，绝无 key 明文）。 */
export interface GitRepoView {
  id: string;
  /** 规范化仓库地址（已去 .git 后缀 / trim） */
  repoUrl: string;
  /** 认证方式：ssh_key=SSH 私钥 / https_token=HTTPS token */
  authType: "ssh_key" | "https_token";
  /** 脱敏指纹（展示用，无明文 key） */
  fingerprint: string | null;
  /** 吊销时间（列表仅未吊销；非 null 已撤销） */
  revokedAt: string | null;
  /** 未吊销授权 agent 列表 */
  grantedAgents: GitGrantView[];
  createdAt: string;
}

/** 授权输入条目（POST/PATCH 共用）。 */
export interface GitGrantInput {
  agentId: string;
  /** 缺省 read=allow、write=ask（对齐 17 篇 §3.3） */
  permission: "read" | "write";
  effect: "allow" | "ask";
}

/** POST /git-repos 请求体（grantedAgents 可缺省——创建但不授权任何 agent）。 */
export interface CreateGitRepoPayload {
  repoUrl: string;
  authType: "ssh_key" | "https_token";
  key: string;
  grantedAgents?: GitGrantInput[];
}

/** PATCH /git-repos/:id 请求体（部分更新；key 缺省 = 保留原凭证，仅更新授权）。 */
export interface UpdateGitRepoPayload {
  key?: string;
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
