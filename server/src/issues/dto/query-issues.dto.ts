import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ISSUE_STATUS } from '../issues.constants';

/**
 * GET /issues 查询参数（remove-project-dimension todo 4）。
 * taskId 与 teamId 二选一（taskId 优先，均缺 → 400）：
 * - taskId：按单任务过滤（任务所属团队成员校验）；
 * - teamId：按团队过滤（issue.task.teamId 命中该团队的全部任务 issue，团队成员校验）。
 * status/assigneeAgentId 可选过滤；分页对齐 tasks 看板（page 默认 1、pageSize 默认 20）。
 */
export class QueryIssuesDto {
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
}
