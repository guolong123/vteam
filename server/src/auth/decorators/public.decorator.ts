import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * 标记公开端点（免 JWT 鉴权）。
 * 全局 JwtAuthGuard 经 Reflector 读取该标记，命中即放行。
 * 用于 /auth/register、/auth/login、/auth/refresh、health 等。
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
