import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/**
 * `@ProjectId()` 参数装饰器：从路由参数 `:pid` 提取项目 ID。
 *
 * 供 handler 参数注入使用（复用 current-user.decorator 的 createParamDecorator 风格）：
 *   ```ts
 *   @Post(':pid/tasks')
 *   create(@ProjectId() projectId: string, @Body() dto) { ... }
 *   ```
 *
 * 守卫侧（ProjectMembershipGuard）则优先读路由参数 pid，其次读本装饰器导出的
 * `PROJECT_ID_KEY` metadata（由 handler/controller 用 SetMetadata 标记）。
 */
export const PROJECT_ID_KEY = 'projectId';

export const ProjectId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const pid = request.params?.pid;
    return typeof pid === 'string' && pid.length > 0 ? pid : undefined;
  },
);
