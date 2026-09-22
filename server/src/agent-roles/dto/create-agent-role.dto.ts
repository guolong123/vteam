import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
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
 * POST /agent-roles 请求体（agent-role-entity todo 6；2026-09-21 capability model）。
 * 仅允许创建 `type='custom'`：内置角色由 seed/migration 维护（`type='builtin'`）。
 * 唯一能力字段 `capabilities`（业务能力点矩阵，键 ∈ 能力目录、值 boolean；缺省 = 出厂矩阵）。
 * 引擎原生权限（permission/tools/model/worker）属 ExecutionPolicy / Agent，不由本 DTO 传入。
 */
export class CreateAgentRoleDto {
  @ApiProperty({ description: '角色名称', maxLength: 64 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiProperty({
    description: 'machine-safe 唯一标识（小写字母开头，仅含小写字母/数字/_/-，最长 63 字符）',
    example: 'data-analyst',
  })
  @IsString()
  @Matches(new RegExp(AGENT_KEY_PATTERN), {
    message: `key 格式非法：需匹配 ${AGENT_KEY_PATTERN}（小写字母开头，仅含小写字母/数字/_/-，最长 63 字符）`,
  })
  key: string;

  @ApiProperty({
    description: '角色类型（POST 仅支持 custom；builtin 由种子维护）',
    enum: ['custom'],
  })
  @IsIn(['custom'])
  type: 'custom';

  @ApiPropertyOptional({ description: '角色描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description:
      '预填默认 Agent id（内部；须为已存在的 Agent；null/缺省表示不预填）。' +
      '与 defaultOpencodeAgentName 互斥：至多一个非空，同时给 → 400 AGENT_ROLE_DEFAULT_SLOT_CONFLICT',
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
      `含空格/大写，最长 ${AGENT_ROLE_OPENCODE_AGENT_NAME_MAX_LENGTH} 字符；null/缺省表示不预填）。` +
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
      '业务能力点矩阵（键 ∈ 能力目录如 task.create/issue.manage，值 boolean；false=拒绝，缺失键=允许）。' +
      '缺省 = 出厂矩阵（默认放行 + 敏感能力点预置拒绝）。未知键 / 非 boolean → 400 AGENT_ROLE_CAPABILITY_KEY_INVALID',
    example: { 'task.create': false, 'chat.post': true },
  })
  @IsOptional()
  @IsObject()
  capabilities?: Record<string, boolean>;

  @ApiPropertyOptional({ description: '角色指令（"这个岗位是什么"）' })
  @IsOptional()
  @IsString()
  rolePrompt?: string;

  @ApiPropertyOptional({ description: '展示排序（越小越前）', default: 0, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
