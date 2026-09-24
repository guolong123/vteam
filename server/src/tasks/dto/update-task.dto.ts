import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TASK_PRIORITY } from '../../common/constants/task.constants';

/**
 * PATCH /tasks/:id 请求体（09 篇 §3.4 Tasks 编辑）。
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
      '背景文档元数据数组（is_0000000011：PATCH 支持更新任务背景文档，与 create 同形状 [{name,url}]，传 [] 清空）',
  })
  @IsOptional()
  @IsArray()
  backgroundDocs?: unknown[];

  @ApiPropertyOptional({
    description:
      '完成后为下一任务开新会话（覆盖团队 reuseSession，默认 false）',
  })
  @IsOptional()
  @IsBoolean()
  resetAfterComplete?: boolean;
}
