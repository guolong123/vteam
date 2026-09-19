import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { AGENT_KEY_PATTERN } from '../../common/constants/agent.constants';

/**
 * POST /agents/:id/clone 请求体（09 篇 §3.7 FR-31）。
 * name 缺省时服务层以「源名称 + 副本」命名。
 * agentKey 必填：克隆体是全新的 opencode agent（`vteam-<agentKey>`），必须分配
 * 自己的 key，源的 key 绝不复制。
 */
export class CloneAgentDto {
  @ApiPropertyOptional({
    description: '克隆副本名称（缺省源名称+「副本」）',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({
    description:
      '岗位 id（AgentRole）备用能力模板：仅当**源无绑定策略**时用于取起始 config' +
      '（取岗位 defaultAgentId 的 Agent 的 policyId，深拷贝为新 custom 策略）；' +
      '源有绑定策略时本字段被忽略（源策略深拷贝恒胜出）。',
    example: 'ar_developer',
  })
  @IsOptional()
  @IsString()
  agentRoleId?: string;

  @ApiProperty({
    description:
      '克隆体的 machine-safe 标识（opencode agent 名 = `vteam-<agentKey>`；源 key 不可复用）',
    example: 'demo-agent-copy',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(new RegExp(AGENT_KEY_PATTERN), {
    message: `agentKey 格式非法：需匹配 ${AGENT_KEY_PATTERN}（小写字母开头，仅含小写字母/数字/_/-，最长 63 字符）`,
  })
  @Matches(/^(?!vteam-).+$/, {
    message:
      'agentKey 不能以 `vteam-` 开头，否则 opencode agent 名会变成 `vteam-vteam-<key>`',
  })
  agentKey: string;
}
