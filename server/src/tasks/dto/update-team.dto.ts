import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { TaskAgentInput } from './create-task.dto';

/**
 * POST /tasks/:id/team 请求体（09 篇 §3.4 团队调整，FR-02；角色/实例分离 T2）。
 * addInstances 新增实例（agentId 可重复 = 同一 agent 添加多实例，服务端生成 seq）；
 * removeInstanceIds 按实例 id 移除。两字段均可选，至少提供其一才有实际变更；
 * 全部幂等分支（remove 目标不存在/已移除）时返回当前任务（200 幂等，与状态迁移一致）。
 */
export class UpdateTeamDto {
  @ApiPropertyOptional({
    description: '新增实例列表（agentId 可重复，服务端生成 seq）',
    type: [TaskAgentInput],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskAgentInput)
  addInstances?: TaskAgentInput[];

  @ApiPropertyOptional({
    description: '移除的实例 id 列表（不在团队/已移除者幂等跳过）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  removeInstanceIds?: string[];
}
