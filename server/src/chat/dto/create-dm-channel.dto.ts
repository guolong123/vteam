import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** POST /dm-channels 请求体：创建 private 私聊频道（teamMember 维度复用）。 */
export class CreateDmChannelDto {
  @ApiProperty({
    description: '所属团队 id（私聊频道 team_id 关联，每团队成员一频道复用）',
  })
  @IsString()
  @IsNotEmpty()
  teamId: string;

  /** 团队成员 id（tmm_ 前缀，TeamMember.id）。与 agentId 二选一，优先 teamMemberId。 */
  @ApiPropertyOptional({
    description: '私聊目标团队成员 id（tmm_ 前缀；与 agentId 二选一）',
  })
  @IsOptional()
  @IsString()
  teamMemberId?: string;

  /** 私聊对象 Agent id（用于按 teamId+agentId 解析到 TeamMember，兼容单实例）。 */
  @ApiPropertyOptional({
    description: '私聊对象 Agent id（按 teamId+agentId 解析到首个 TeamMember）',
  })
  @IsOptional()
  @IsString()
  agentId?: string;
}
