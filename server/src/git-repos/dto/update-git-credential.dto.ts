import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * PATCH /git-credentials/:id 请求体（全可选部分更新）。
 * - name 提供 → 校验全局唯一（未吊销）→ 409；
 * - key 提供 → 重加密覆盖 credentialRef/fingerprint；
 * - description 提供 → 覆盖；缺省均为不变。
 */
export class UpdateGitCredentialDto {
  @ApiPropertyOptional({
    description: '新凭证名称（提供则校验全局唯一）',
    example: 'gitee-ssh-main',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({
    description: '新 SSH 私钥 / HTTPS token（提供则重加密覆盖）',
    example: '-----BEGIN OPENSSH PRIVATE KEY-----...',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  key?: string;

  @ApiPropertyOptional({
    description: '新描述（提供则覆盖，可空字符串清空）',
    maxLength: 256,
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  description?: string;
}
