import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * GET /models 查询参数（enabled 过滤 + providerID/modelID/name 模糊搜索 + 分页，
 * 对齐 QueryMcpServersDto 模式，返回 {items, total, page, pageSize}）。
 */
export class QueryModelsDto {
  @ApiPropertyOptional({
    description: '启用状态过滤（true 仅启用 / false 仅停用），缺省返回全部',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsIn([true, false])
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'providerID 模糊搜索（contains）' })
  @IsOptional()
  @IsString()
  providerID?: string;

  @ApiPropertyOptional({ description: 'modelID 模糊搜索（contains）' })
  @IsOptional()
  @IsString()
  modelID?: string;

  @ApiPropertyOptional({ description: 'name 模糊搜索（contains）' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: '页码（从 1 起）', default: 1, minimum: 1 })
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
