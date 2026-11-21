import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  TASK_PRIORITY,
  TASK_STATUS,
} from '../../common/constants/task.constants';
import { PaginatedQueryDto } from '../../common/dto/paginated-query.dto';

/** GET /tasks?teamId= 看板查询参数（分页对齐 09 篇 §2.2：page/pageSize 默认 1/20，上限 100）。 */
export class QueryTasksDto extends PaginatedQueryDto {
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
