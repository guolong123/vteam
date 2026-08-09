import { SetMetadata } from '@nestjs/common';

/**
 * 权限点 metadata key（PermissionGuard 经 Reflector 读取）。
 * 格式：`resource.action`，对齐 PERMISSION_RESOURCES × PERMISSION_ACTIONS
 * （8 资源 × 6 操作：tasks/chats/artifacts/agents/workers/skills/users/roles ×
 * view/create/edit/delete/review/manage，见 users/roles.constants.ts）。
 */
export const REQUIRE_PERMISSION_KEY = 'requirePermission';

/**
 * `@RequirePermission('agents.view')` 方法级装饰器：
 * 标记该端点所需权限点，配合 `@UseGuards(PermissionGuard)` 使用。
 *
 * ```ts
 * @UseGuards(PermissionGuard)
 * @RequirePermission('agents.create')
 * @Post()
 * create(@CurrentUser() user, @Body() dto) { ... }
 * ```
 */
export const RequirePermission = (permission: string) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);
