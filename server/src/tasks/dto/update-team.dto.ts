import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * POST /tasks/:id/team 请求体（09 篇 §3.4 团队调整，FR-02）。
 * addAgentIds / removeAgentIds 均可选，至少提供其一才有实际变更；
 * 两数组皆空或全部命中幂等分支时返回当前任务（200 幂等，与状态迁移一致）。
 */
export class UpdateTeamDto {
  @ApiPropertyOptional({
    description: '加入团队的 Agent id 列表（已存在未移除者幂等跳过）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  addAgentIds?: string[];

  @ApiPropertyOptional({
    description: '移出团队的 Agent id 列表（不在团队/已移除者幂等跳过）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  removeAgentIds?: string[];
}
