import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { AGENT_KEY_PATTERN } from '../../common/constants/agent.constants';
import { AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH } from '../../common/constants/agent-role.constants';

/**
 * PATCH /agent-roles/:id 请求体（agent-role-entity todo 6；2026-09-21 capability model）。
 * 全字段可选。内置角色（`type='builtin'`）允许编辑 `name`/`description`/`rolePrompt`/
 * `defaultAgentId`/**`capabilities`**（角色编排页读取并编辑），但 `key` 不可改（service 层 403）；
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
    description:
      'machine-safe 唯一标识（仅 custom 可改；内置角色改 key → 403）',
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
    description:
      '预填默认 Agent id（内部；null 显式清除；不传保持原值）。' +
      '与 defaultOpencodeAgentName 互斥：设置其一自动清空另一个',
    example: 'a_developer',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o) => o.defaultAgentId !== null)
  @IsString()
  defaultAgentId?: string | null;

  @ApiPropertyOptional({
    description:
      '预填默认**外部引擎** Agent 名（opencode agent 名，如 `Prometheus - Plan Builder`；' +
      `含空格/大写，最长 ${AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH} 字符；null/空串显式清除；不传保持原值）。` +
      '与 defaultAgentId 互斥：至多一个非空，同时给 → 400 AGENT_ROLE_DEFAULT_SLOT_CONFLICT',
    example: 'Prometheus - Plan Builder',
    nullable: true,
    maxLength: AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH,
  })
  @IsOptional()
  @ValidateIf((o) => o.defaultOpencodeAgentName !== null)
  @IsString()
  @MaxLength(AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH)
  defaultOpencodeAgentName?: string | null;

  @ApiPropertyOptional({
    description:
      '业务能力点矩阵（整体替换；键 ∈ 能力目录，值 boolean；false=拒绝，缺失键=允许；不传保持原值）。' +
      '未知键 / 非 boolean → 400 AGENT_ROLE_CAPABILITY_KEY_INVALID',
    example: { 'task.create': false, 'chat.post': true },
  })
  @IsOptional()
  @IsObject()
  capabilities?: Record<string, boolean>;

  @ApiPropertyOptional({
    description: '角色指令（"这个岗位是什么"，可编辑文本）',
  })
  @IsOptional()
  @IsString()
  rolePrompt?: string;

  @ApiPropertyOptional({ description: '展示排序（越小越前）', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
