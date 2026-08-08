import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/** GET /projects 分页与筛选查询参数（分页对齐 09 篇 §2）。 */
export class QueryProjectsDto {
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

  @ApiPropertyOptional({
    description: '项目状态筛选（active/archived）',
    enum: ['active', 'archived'],
  })
  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: string;
}
