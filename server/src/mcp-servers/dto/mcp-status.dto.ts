import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** MCP 服务器可用性三态（T8c，11 篇 §5.8）。 */
export const MCP_STATUS = {
  CONNECTED: 'connected',
  FAILED: 'failed',
  NEEDS_AUTH: 'needs_auth',
} as const;

export type McpStatus = (typeof MCP_STATUS)[keyof typeof MCP_STATUS];

/**
 * 心跳载荷中的单条 MCP 服务器状态（T8c）。
 * serverName 与 mcp_servers.name 对应；status 为 worker 探测结果
 * （needs_auth / connected / failed，11 篇 §5.8）。
 */
export class McpStatusEntryDto {
  @ApiProperty({ description: 'MCP 服务器名称（与 mcp_servers.name 对应）' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  serverName: string;

  @ApiProperty({
    description: 'MCP 服务器可用性（needs_auth / connected / failed）',
    enum: Object.values(MCP_STATUS),
  })
  @IsIn(Object.values(MCP_STATUS))
  status: McpStatus;
}
