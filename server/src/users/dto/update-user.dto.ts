import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * PATCH /users/:id 请求体（ISSUE-002 修复：用户编辑）。
 * 全字段可选——仅更新提交的字段；email 传 null 表示清空邮箱。
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ description: '登录名，唯一（变更时校验冲突）', example: 'alice' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  username?: string;

  @ApiPropertyOptional({ description: '展示名', example: 'Alice' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  displayName?: string;

  @ApiPropertyOptional({
    description: '可选邮箱，唯一；null 表示清空',
    example: 'alice@x.com',
    nullable: true,
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string | null;

  @ApiPropertyOptional({ description: '目标角色 id（需已存在）', example: 'r_member' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  roleId?: string;
}
