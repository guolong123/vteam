import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * PATCH /roles/:id 请求体（Phase 3 T8 更新自定义角色）。
 * 预置角色（isBuiltin）一律 403，仅自定义角色可更新。
 */
export class UpdateRoleDto {
  @ApiPropertyOptional({ description: '角色名，唯一', example: 'reviewer' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({
    description: '权限矩阵：8 资源 × 6 操作',
    example: {
      tasks: {
        view: true,
        create: true,
        edit: true,
        delete: true,
        review: true,
        manage: false,
      },
    },
  })
  @IsOptional()
  @IsObject()
  permissions?: Record<string, unknown>;

  @ApiPropertyOptional({ description: '权限范围' })
  @IsOptional()
  @IsObject()
  scopes?: Record<string, unknown>;
}
