import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * POST /dm-channels 请求体。
 * - 新形状：{ memberId }（成员维度；服务端解析其席位与上下文团队）
 * - 旧形状：{ teamId, teamMemberId | agentId }（兼容一期）
 */
export class CreateDmChannelDto {
  @ApiPropertyOptional({
    description:
      '所属团队 id（旧形状必填；memberId 形状可省略，由成员席位解析）',
  })
  @IsOptional()
  @IsString()
  teamId?: string;

  @ApiPropertyOptional({
    description: '成员 id（mbr_ 前缀；新形状，与 teamMemberId/agentId 互斥）',
  })
  @IsOptional()
  @IsString()
  memberId?: string;

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
