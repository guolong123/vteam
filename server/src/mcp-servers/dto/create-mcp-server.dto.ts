import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

/** MCP 服务器类型枚举（11 篇 §5.1：local 子进程 / remote HTTP 服务）。 */
export const MCP_SERVER_TYPES = ['local', 'remote'] as const;
export type McpServerType = (typeof MCP_SERVER_TYPES)[number];

/**
 * POST /mcp-servers 请求体（字段对齐 11 篇 §5.1 opencode mcp 配置节）：
 * - local：command（{command[], cwd?, environment?, timeout?}）
 * - remote：url + headers? + oauth?（对象或 false 显式禁用）
 * 分支依赖校验（local 必填 command、remote 必填合法 url）在 service 层完成，
 * 此处做字段类型与格式基础校验。
 */
export class CreateMcpServerDto {
  @ApiProperty({
    description: '服务器唯一名称（opencode mcp 节键名，如 gitee-ent）',
    example: 'gitee-ent',
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9-_.]*$/, {
    message: 'name 需为小写字母/数字/连字符/下划线/点开头（如 gitee-ent）',
  })
  name: string;

  @ApiProperty({
    description: '服务器类型（local 子进程 / remote HTTP 服务）',
    enum: MCP_SERVER_TYPES,
  })
  @IsIn(MCP_SERVER_TYPES)
  type: McpServerType;

  @ApiPropertyOptional({
    description:
      'local 配置：{command: string[], cwd?, environment?, timeout?}，type=local 时必填且 command 非空数组',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  command?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'remote 配置：合法 http(s) URL，type=remote 时必填',
    example: 'https://my-mcp-server.com',
  })
  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\/.+/, {
    message: 'url 需为合法 http(s) 地址',
  })
  url?: string;

  @ApiPropertyOptional({
    description: 'remote 请求头（如 {Authorization: "Bearer {env:API_KEY}"}）',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  headers?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'OAuth 配置对象（{clientId?, clientSecret?, scope?}）或 false（显式禁用自动 OAuth）',
    type: Object,
  })
  @IsOptional()
  @ValidateIf((o) => o.oauth !== false)
  @IsObject()
  oauth?: Record<string, unknown> | false;

  @ApiPropertyOptional({ description: '是否启用', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
