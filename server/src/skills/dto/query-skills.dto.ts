import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * GET /skills 查询参数：enabled 过滤 + name 模糊搜索 + 分页（对齐 QueryAgentsDto 模式）。
 * enabled 为 query string（"true"/"false"），经 Transform 归一为 boolean，非法值交由 IsBoolean 400。
 */
export class QuerySkillsDto {
  @ApiPropertyOptional({
    description: '启用状态过滤（true/false），缺省返回全部',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) return undefined;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: '按名称模糊搜索（contains）' })
  @IsOptional()
  @IsString()
  name?: string;

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
