import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/**
 * GET /agent-roles 查询参数（type 过滤 + 分页，对齐 QueryAgentsDto / QueryExecutionPoliciesDto 模式）。
 */
export class QueryAgentRolesDto {
  @ApiPropertyOptional({
    description: '角色类型筛选（builtin/custom），缺省返回全部（内置优先）',
    enum: ['builtin', 'custom'],
  })
  @IsOptional()
  @IsIn(['builtin', 'custom'])
  type?: string;

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

  @ApiPropertyOptional({ description: '每页条数', default: 20, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
