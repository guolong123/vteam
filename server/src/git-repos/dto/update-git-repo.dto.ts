import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { GitGrantInput } from './create-git-repo.dto';

/**
 * PATCH /git-repos/:id 请求体（全可选部分更新）。
 * - key 提供 → 重加密覆盖 credentialRef/fingerprint（保留原 repoUrl/authType）；
 * - grantedAgents 提供 → 全量覆盖授权（先软撤该仓库旧授权 → 写入新授权）；
 * - 两项均缺省 → 幂等返回当前视图。
 */
export class UpdateGitRepoDto {
  @ApiPropertyOptional({
    description: '新的 SSH 私钥 / HTTPS token（提供则重加密覆盖，缺省不变）',
    example: '-----BEGIN OPENSSH PRIVATE KEY-----...',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  key?: string;

  @ApiPropertyOptional({
    description: '授权 Agent 全量覆盖（缺省不变；提供则先软撤旧授权再写入新授权）',
    type: [GitGrantInput],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GitGrantInput)
  grantedAgents?: GitGrantInput[];
}
