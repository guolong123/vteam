import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import {
  TASK_PRIORITY,
  TASK_STATUS,
} from '../../common/constants/task.constants';

/** GET /projects/:pid/tasks 看板查询参数（分页对齐 09 篇 §2.2：page/pageSize 默认 1/20）。 */
export class QueryTasksDto {
  @ApiPropertyOptional({
    description: '页码（从 1 起）',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: '每页条数（上限 100）',
    default: 20,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @ApiPropertyOptional({
    description:
      '五态筛选（pending/in_progress/pending_review/completed/archived）',
    enum: Object.values(TASK_STATUS),
  })
  @IsOptional()
  @IsIn(Object.values(TASK_STATUS))
  status?: string;

  @ApiPropertyOptional({
    description: '优先级筛选（high/medium/low）',
    enum: Object.values(TASK_PRIORITY),
  })
  @IsOptional()
  @IsIn(Object.values(TASK_PRIORITY))
  priority?: string;
}
