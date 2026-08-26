import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { GIT_AUTH_TYPES } from '../git-repos.constants';

/**
 * POST /git-credentials 请求体（凭证池独立创建）。
 * - name 全局唯一（未吊销）→ 409 CREDENTIAL_NAME_EXISTS；
 * - authType 仅 ssh_key|https_token；
 * - key 明文仅请求体与加密存储（AES-256-GCM），响应只出 fingerprint；
 * - description 可选说明。
 */
export class CreateGitCredentialDto {
  @ApiProperty({
    description: '凭证名称（全局唯一，人类可识别）',
    example: 'gitee-ssh-main',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiProperty({
    description: '认证方式：ssh_key|https_token',
    enum: Object.values(GIT_AUTH_TYPES),
  })
  @IsIn(Object.values(GIT_AUTH_TYPES))
  authType: 'ssh_key' | 'https_token';

  @ApiProperty({
    description: 'SSH 私钥明文 / HTTPS token（加密存储，绝不返回明文）',
    example: '-----BEGIN OPENSSH PRIVATE KEY-----...',
  })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiPropertyOptional({
    description: '凭证描述（可选）',
    example: '用于 gitee.com 的主 SHH 密钥',
    maxLength: 256,
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}
