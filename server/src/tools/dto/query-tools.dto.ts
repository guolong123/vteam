import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { TOOL_EXECUTIONS, TOOL_SOURCES } from './create-tool.dto';

/**
 * GET /tools 查询参数（source/execution/enabled 过滤 + name 搜索 + 分页，
 * 对齐 QueryAgentsDto 模式，返回 {items, total, page, pageSize}）。
 */
export class QueryToolsDto {
  @ApiPropertyOptional({
    description: '工具来源过滤（builtin/custom/mcp），缺省返回全部',
    enum: TOOL_SOURCES,
  })
  @IsOptional()
  @IsIn(TOOL_SOURCES)
  source?: string;

  @ApiPropertyOptional({
    description: '执行方式过滤（code/cli/http/mcp），缺省返回全部',
    enum: TOOL_EXECUTIONS,
  })
  @IsOptional()
  @IsIn(TOOL_EXECUTIONS)
  execution?: string;

  @ApiPropertyOptional({
    description: '启用状态过滤（true 仅启用 / false 仅停用），缺省返回全部',
  })
  @IsOptional()
  @Transform(({ value }) => {
    // "true"/"false" 字符串 → 布尔；其余非法值忽略（不过滤）
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsIn([true, false])
  enabled?: boolean;

  @ApiPropertyOptional({ description: '工具名称模糊搜索（name contains）' })
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
