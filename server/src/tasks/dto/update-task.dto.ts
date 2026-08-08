import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { TASK_PRIORITY } from '../../common/constants/task.constants';

/**
 * PATCH /tasks/:id 请求体（09 篇 §3.4 Tasks 编辑）。
 * mainAgentId 服务层校验须为团队内已选 Agent（FR-08）；传 null 表示清除主 Agent。
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
    description: '主 Agent id（须为团队内已选 Agent，FR-08）',
  })
  @IsOptional()
  @IsString()
  mainAgentId?: string | null;
}
