import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ISSUE_STATUS } from '../issues.constants';

/**
 * GET /issues 查询参数（issue-management plan todo 2）。
 * taskId 必填（issue 仅任务绑定）；status/assigneeAgentId 可选过滤；
 * 分页对齐 tasks 看板（page 默认 1、pageSize 默认 20）。
 */
export class QueryIssuesDto {
  @ApiProperty({ description: '任务 id（必填，按任务过滤）' })
  @IsString()
  taskId: string;

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

  @ApiPropertyOptional({ description: '页码（从 1 起）', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数（上限 100）', default: 20, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
