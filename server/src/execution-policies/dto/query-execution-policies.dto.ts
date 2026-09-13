import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/**
 * GET /execution-policies 查询参数（type 过滤 + 分页，对齐 QueryAgentsDto 模式）。
 */
export class QueryExecutionPoliciesDto {
  @ApiPropertyOptional({
    description: '策略类型筛选（template/custom），缺省返回全部',
    enum: ['template', 'custom'],
  })
  @IsOptional()
  @IsIn(['template', 'custom'])
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
