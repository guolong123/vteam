import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { AGENT_KEY_PATTERN } from '../../common/constants/agent.constants';

/**
 * PATCH /agent-roles/:id 请求体（agent-role-entity todo 6）。
 * 全字段可选。内置角色（`type='builtin'`）允许编辑 `name`/`description`/`rolePrompt`/
 * `defaultAgentId`（Roles tab 读取它们），但 `key` 不可改（service 层 403）；
 * `type` 不在 DTO，天然不可改（镜像 agents/policies 的 type 安全红线）。
 */
export class UpdateAgentRoleDto {
  @ApiPropertyOptional({ description: '角色名称', maxLength: 64 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({
    description: 'machine-safe 唯一标识（仅 custom 可改；内置角色改 key → 403）',
    example: 'data-analyst',
  })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(AGENT_KEY_PATTERN), {
    message: `key 格式非法：需匹配 ${AGENT_KEY_PATTERN}（小写字母开头，仅含小写字母/数字/_/-，最长 63 字符）`,
  })
  key?: string;

  @ApiPropertyOptional({ description: '角色描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: '预填默认 Agent id（null 显式清除；不传保持原值）',
    example: 'a_developer',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o) => o.defaultAgentId !== null)
  @IsString()
  defaultAgentId?: string | null;

  @ApiPropertyOptional({ description: '角色指令（"这个岗位是什么"，可编辑文本）' })
  @IsOptional()
  @IsString()
  rolePrompt?: string;

  @ApiPropertyOptional({ description: '展示排序（越小越前）', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
