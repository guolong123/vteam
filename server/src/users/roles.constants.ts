/**
 * 角色权限矩阵常量（Phase 3 T8，对齐 docs/agent-platform/prototypes/role-permission）。
 * 8 资源 × 6 操作；三态：true=允许 / false=禁止 / undefined=未配置（视为禁止）。
 */

/** 9 个平台资源域（原型 RESOURCES 的英文 key + 渠道集成） */
export const PERMISSION_RESOURCES = [
  'tasks', // 任务
  'chats', // 群聊
  'artifacts', // 产出物
  'agents', // Agent 配置
  'workers', // Worker 节点
  'skills', // 技能工具
  'users', // 用户管理
  'roles', // 权限配置
  'channels', // 集成渠道
] as const;

/** 6 个操作（原型 ACTIONS：查看/创建/编辑/删除/验收/管理） */
export const PERMISSION_ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'review',
  'manage',
] as const;

/** 空矩阵：8 资源 × 6 操作全 false（POST /roles 未传 permissions 时的兜底） */
export function emptyPermissions(): Record<string, Record<string, boolean>> {
  const matrix: Record<string, Record<string, boolean>> = {};
  for (const res of PERMISSION_RESOURCES) {
    matrix[res] = {};
    for (const act of PERMISSION_ACTIONS) {
      matrix[res][act] = false;
    }
  }
  return matrix;
}

/**
 * 预置角色判断：isBuiltin=true（schema.role.is_builtin，seed 已给 admin/member 置位）。
 * name 双保险：即使存量数据 isBuiltin 缺失，也按内置名兜底只读。
 */
export const BUILTIN_ROLE_NAMES = ['admin', 'member'] as const;

export function isBuiltinRole(role: {
  isBuiltin?: boolean;
  name: string;
}): boolean {
  return (
    role.isBuiltin === true ||
    (BUILTIN_ROLE_NAMES as readonly string[]).includes(role.name)
  );
}
