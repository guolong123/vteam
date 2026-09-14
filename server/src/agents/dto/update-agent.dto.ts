import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PERSONA_LIBRARY } from '../persona.constants';
import { AGENT_KEY_PATTERN } from '../../common/constants/agent.constants';

/**
 * PATCH /agents/:id 请求体（09 篇 §3.7：FR-33~36/47/48）。
 * skillIds 显式传入时重建关联（deleteMany + create），不传则保持原关联。
 * 权限只读经 policyId 绑定 ExecutionPolicy（effectivePermission 经服务端解析返回）。
 */
export class UpdateAgentDto {
  @ApiPropertyOptional({ description: 'Agent 名称', maxLength: 64 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '角色 key' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({
    description:
      'Agent machine-safe 标识（opencode agent 名 = `vteam-<agentKey>`；仅显式传入时更新）',
    example: 'demo-agent',
  })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(AGENT_KEY_PATTERN), {
    message: `agentKey 格式非法：需匹配 ${AGENT_KEY_PATTERN}（小写字母开头，仅含小写字母/数字/_/-，最长 63 字符）`,
  })
  @Matches(/^(?!vteam-).+$/, {
    message:
      'agentKey 不能以 `vteam-` 开头，否则 opencode agent 名会变成 `vteam-vteam-<key>`',
  })
  agentKey?: string;

  @ApiPropertyOptional({ description: '角色提示词（FR-33，作用于后续会话）' })
  @IsOptional()
  @IsString()
  prompt?: string;

  @ApiPropertyOptional({
    description:
      'Agent 性格（PERSONA_LIBRARY 预设 key，null=清除性格；第五维协作风格，不改变权限/工具边界）',
    enum: Object.keys(PERSONA_LIBRARY),
    example: 'strict',
  })
  @IsOptional()
  @IsIn(Object.keys(PERSONA_LIBRARY))
  persona?: string | null;

  @ApiPropertyOptional({
    description: '勾选技能 id 列表（重建 agent_skills 关联）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skillIds?: string[];

  @ApiPropertyOptional({
    description: '默认模型 id（D7：opencode 模型 id，provider/model 格式）',
    example: 'opencode-go/deepseek-v4-flash',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[^\s\/]+\/[^\s\/]+$/, {
    message:
      'defaultModelId 需为 provider/model 格式（如 opencode-go/deepseek-v4-flash）',
  })
  defaultModelId?: string;

  @ApiPropertyOptional({
    description: '首选 worker id（软绑定，可空 null=自动调度；C6）',
    example: 'wkr_0000000001',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.workerId !== null)
  workerId?: string | null;

  @ApiPropertyOptional({
    description:
      '绑定的 ExecutionPolicy id（custom 经 PATCH 改 policyId 生效；模板 policyId 由 seed 维护）',
    example: 'ep_developer',
  })
  @IsOptional()
  @IsString()
  policyId?: string;
}
