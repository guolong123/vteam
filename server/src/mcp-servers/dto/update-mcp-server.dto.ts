import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { MCP_SERVER_TYPES, type McpServerType } from './create-mcp-server.dto';

/**
 * PATCH /mcp-servers/:id 请求体（全可选部分更新）。
 * 改 type 或 command/url 时按「合并后的最终配置」重新做分支校验 → 400。
 * name 改唯一时同样校验冲突 → 409 MCP_SERVER_NAME_EXISTS。
 */
export class UpdateMcpServerDto {
  @ApiPropertyOptional({ description: '服务器唯一名称', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9-_.]*$/, {
    message: 'name 需为小写字母/数字/连字符/下划线/点开头（如 gitee-ent）',
  })
  name?: string;

  @ApiPropertyOptional({
    description: '服务器类型（local / remote）',
    enum: MCP_SERVER_TYPES,
  })
  @IsOptional()
  @IsIn(MCP_SERVER_TYPES)
  type?: McpServerType;

  @ApiPropertyOptional({
    description:
      'local 配置：{command: string[], cwd?, environment?, timeout?}',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  command?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'remote 配置：合法 http(s) URL（可传 null 清空）',
    example: 'https://my-mcp-server.com',
  })
  @IsOptional()
  @ValidateIf((o) => o.url !== null && o.url !== undefined)
  @IsString()
  @Matches(/^https?:\/\/.+/, {
    message: 'url 需为合法 http(s) 地址',
  })
  url?: string | null;

  @ApiPropertyOptional({ description: 'remote 请求头', type: Object })
  @IsOptional()
  @IsObject()
  headers?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'OAuth 配置对象或 false（显式禁用自动 OAuth）',
    type: Object,
  })
  @IsOptional()
  @ValidateIf((o) => o.oauth !== false)
  @IsObject()
  oauth?: Record<string, unknown> | false;

  @ApiPropertyOptional({ description: '是否启用（false=停用）' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
