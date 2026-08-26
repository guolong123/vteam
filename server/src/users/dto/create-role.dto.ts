import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * POST /roles 请求体（Phase 3 T8 自定义角色）。
 * permissions 对齐原型 role-permission 权限矩阵：
 *   8 资源 × 6 操作，如 `{ users: { view: true, create: true, manage: false }, ... }`。
 */
export class CreateRoleDto {
  @ApiProperty({
    description: '角色名，唯一（如 验收员）',
    example: 'reviewer',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiProperty({
    description:
      '权限矩阵：8 资源（tasks/chats/artifacts/agents/workers/skills/users/roles）× 6 操作（view/create/edit/delete/review/manage）',
    example: {
      tasks: {
        view: true,
        create: true,
        edit: true,
        delete: false,
        review: true,
        manage: false,
      },
    },
  })
  @IsObject()
  permissions: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      '权限范围（默认 { global: false, projects: [], innerRoles: [] }）',
    example: { global: false, projects: [], innerRoles: [] },
  })
  @IsOptional()
  @IsObject()
  scopes?: Record<string, unknown>;
}
