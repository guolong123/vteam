import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { TASK_PRIORITY } from '../../common/constants/task.constants';

/**
 * PATCH /tasks/:id 请求体（09 篇 §3.4 Tasks 编辑）。
 * mainAgentInstanceId 为主实例（决策依据，须为团队内实例）；mainAgentId 保留兼容映射
 * （服务层校验须为团队内实例对应 agent，并同步映射 mainAgentInstanceId）。
 * 传 null 表示清除主 Agent。
 */
export class UpdateTaskDto {
  @ApiPropertyOptional({ description: '任务标题', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  title?: string;

  @ApiPropertyOptional({ description: '任务描述' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: '优先级（high/medium/low）',
    enum: Object.values(TASK_PRIORITY),
  })
  @IsOptional()
  @IsIn(Object.values(TASK_PRIORITY))
  priority?: string;

  @ApiPropertyOptional({
    description:
      '主 Agent 实例 id（FR-08，须为团队内实例；传 null 表示清除主 Agent）',
  })
  @IsOptional()
  @IsString()
  mainAgentInstanceId?: string | null;

  @ApiPropertyOptional({
    description:
      '主 Agent id（FR-08 兼容映射：未传 mainAgentInstanceId 时按其映射到该 agent 第一个实例；须为团队内实例对应 agent）',
  })
  @IsOptional()
  @IsString()
  mainAgentId?: string | null;

  @ApiPropertyOptional({
    description:
      '背景文档元数据数组（is_0000000011：PATCH 支持更新任务背景文档，与 create 同形状 [{name,url}]，传 [] 清空）',
  })
  @IsOptional()
  @IsArray()
  backgroundDocs?: unknown[];
}
