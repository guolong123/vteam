import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ISSUE_STATUS } from '../issues.constants';
import { PaginatedQueryDto } from '../../common/dto/paginated-query.dto';

/**
 * GET /issues 查询参数（remove-project-dimension todo 4）。
 * taskId 与 teamId 二选一（taskId 优先，均缺 → 400）：
 * - taskId：按单任务过滤（任务所属团队成员校验）；
 * - teamId：按团队过滤（issue.task.teamId 命中该团队的全部任务 issue，团队成员校验）。
 * status/assigneeAgentId 可选过滤；分页对齐 tasks 看板（page 默认 1、pageSize 默认 20）。
 */
export class QueryIssuesDto extends PaginatedQueryDto {
  @ApiPropertyOptional({
    description: '任务 id（按任务过滤，与 teamId 二选一）',
  })
  @IsOptional()
  @IsString()
  taskId?: string;

  @ApiPropertyOptional({
    description: '团队 id（按团队下全部任务过滤，与 taskId 二选一）',
  })
  @IsOptional()
  @IsString()
  teamId?: string;

  @ApiPropertyOptional({
    description: '状态筛选（open/in_progress/resolved/closed）',
    enum: Object.values(ISSUE_STATUS),
  })
  @IsOptional()
  @IsIn(Object.values(ISSUE_STATUS))
  status?: string;

  @ApiPropertyOptional({ description: '指派 Agent id 筛选' })
  @IsOptional()
  @IsString()
  assigneeAgentId?: string;
}
