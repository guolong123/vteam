import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { MCP_SERVER_TYPES } from './create-mcp-server.dto';
import { PaginatedQueryDto } from '../../common/dto/paginated-query.dto';

/**
 * GET /mcp-servers 查询参数（type/enabled 过滤 + name 搜索 + 分页，
 * 对齐 QueryToolsDto 模式，返回 {items, total, page, pageSize}）。
 */
export class QueryMcpServersDto extends PaginatedQueryDto {
  @ApiPropertyOptional({
    description: '服务器类型过滤（local/remote），缺省返回全部',
    enum: MCP_SERVER_TYPES,
  })
  @IsOptional()
  @IsIn(MCP_SERVER_TYPES)
  type?: string;

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

  @ApiPropertyOptional({ description: '服务器名称模糊搜索（name contains）' })
  @IsOptional()
  @IsString()
  name?: string;
}
