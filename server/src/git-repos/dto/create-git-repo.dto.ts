import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { GIT_EFFECTS, GIT_PERMISSIONS } from '../git-repos.constants';

/**
 * 授权条目（GitRepoGrant 行输入）。
 * - permission/effect 可缺省：service 层按 `read→allow、write→ask` 补齐默认
 *   （对齐 17 篇 §3.1 effect 设计，写操作默认需成员确认）；
 * - 显式提供时校验枚举值（越界 → 400 GRANT_INVALID）。
 */
export class GitGrantInput {
  @ApiProperty({ description: 'Agent 实例 id（授权主体，agent 粒度）', example: 'a_tester' })
  @IsString()
  @IsNotEmpty()
  agentId: string;

  @ApiPropertyOptional({
    description: '仓库权限：read | write（write 含 read，git_push 需 write）',
    enum: Object.values(GIT_PERMISSIONS),
    default: 'read',
  })
  @IsOptional()
  @IsIn(Object.values(GIT_PERMISSIONS))
  permission?: 'read' | 'write';

  @ApiPropertyOptional({
    description: '生效方式：allow | ask（缺省 read→allow、write→ask）',
    enum: Object.values(GIT_EFFECTS),
  })
  @IsOptional()
  @IsIn(Object.values(GIT_EFFECTS))
  effect?: 'allow' | 'ask';
}

/**
 * POST /git-repos 请求体（仓库创建 + 授权，选择已有凭证）。
 * - repoUrl 唯一（@@unique，未吊销）→ 409 REPO_EXISTS；
 * - credentialId 指向未吊销凭证池条目，不存在 → 404 CREDENTIAL_NOT_FOUND；
 * - grantedAgents 可缺省（创建仓库但不授权任何 agent，此时凭证不会下发到任何 worker）。
 */
export class CreateGitRepoDto {
  @ApiProperty({
    description: '仓库地址（支持 ssh git@ 与 https:// 形式，自动 trim + 去尾部 .git）',
    example: 'git@gitee.com:xishuhq/test-repo.git',
  })
  @IsString()
  @IsNotEmpty()
  repoUrl: string;

  @ApiProperty({
    description: '凭证池 id（gc_ 前缀，需为未吊销凭证）',
    example: 'gc_0000000001',
  })
  @IsString()
  @IsNotEmpty()
  credentialId: string;

  @ApiPropertyOptional({
    description: '授权 Agent 列表（可空数组或缺省；agent 不存在 → 400 GRANT_INVALID）',
    type: [GitGrantInput],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GitGrantInput)
  grantedAgents?: GitGrantInput[];
}
