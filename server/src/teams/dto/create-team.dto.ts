import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class TeamMemberInput {
  @ApiProperty({ description: '模板 Agent id（同一 agent 可重复 = 多实例）' })
  @IsString()
  agentId: string;

  @ApiPropertyOptional({
    description: '实例别名（缺省 = `<角色中文名>-<seq>`）',
  })
  @IsOptional()
  @IsString()
  alias?: string;

  @ApiPropertyOptional({
    description:
      '实例持久化工作目录（缺省 = `/data/vteam-worker/<sanitize(agent.name)>`，同 agent 多实例追加 -<seq>）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  workDir?: string;
}

export class CreateTeamDto {
  @ApiProperty({ description: '团队名称（全局唯一）', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  name: string;

  @ApiPropertyOptional({ description: '团队描述' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: '是否复用会话（默认 true）',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  reuseSession?: boolean;

  @ApiPropertyOptional({
    description: '初始成员列表（可空；agentId 可重复 = 多实例）',
    type: [TeamMemberInput],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TeamMemberInput)
  members?: TeamMemberInput[];

  @ApiPropertyOptional({
    description:
      '主 Agent 成员 id（须在 members 对应 TeamMember 范围内，★ 主 Agent）',
  })
  @IsOptional()
  @IsString()
  mainAgentMemberId?: string;
}
