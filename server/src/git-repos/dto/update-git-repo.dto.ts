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
 * - credentialId 提供 → 切换关联凭证（校验存在且未吊销）；
 * - grantedAgents 提供 → 全量覆盖授权（先软撤该仓库旧授权 → 写入新授权）；
 * - 两项均缺省 → 幂等返回当前视图。
 */
export class UpdateGitRepoDto {
  @ApiPropertyOptional({
    description: '新关联凭证 id（提供则切换凭证，校验未吊销）',
    example: 'gc_0000000001',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  credentialId?: string;

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
