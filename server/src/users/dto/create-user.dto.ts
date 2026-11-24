import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * POST /users 请求体（Phase 3 T8 创建用户，管理员操作）。
 * 校验规则与 POST /auth/register 对齐；额外携带 roleId 完成角色分配。
 */
export class CreateUserDto {
  @ApiProperty({ description: '登录名，唯一', example: 'alice' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  username: string;

  @ApiProperty({
    description: '明文密码，bcrypt 哈希后落库',
    example: 'passw0rd',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @MaxLength(128)
  password: string;

  @ApiProperty({ description: '展示名', example: 'Alice' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  displayName: string;

  @ApiPropertyOptional({
    description: '可选邮箱，唯一',
    example: 'alice@x.com',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiProperty({ description: '目标角色 id（需已存在）', example: 'r_member' })
  @IsString()
  @IsNotEmpty()
  roleId: string;

  @ApiPropertyOptional({
    description:
      '可选：创建后加入的工作空间 id（不填 = 首次登录自动创建个人空间）',
    example: 'ws_0000000001',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  workspaceId?: string;

  @ApiPropertyOptional({
    description:
      '可选的加入空间时的空间角色（owner/admin/member；缺省 member；owner 只用于空间创建者）',
    enum: ['admin', 'member'],
    example: 'member',
  })
  @IsOptional()
  @IsIn(['admin', 'member'])
  workspaceRole?: 'admin' | 'member';
}
