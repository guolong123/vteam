import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * MCP 服务器可用性状态（**v2 的五态**，与 worker 侧 `McpServerStatus` 逐字对齐）。
 *
 * ⚠️ **线契约扩展（两端同步，必须一起改）**：旧形态是三态（needs_auth / connected /
 * failed，11 篇 §5.8）。v2 的 `GET /api/mcp` 有五个状态，新增的两个是：
 * - `pending`：**瞬态**，还在连接中（几秒后变 connected）——**不是** failed；
 * - `disabled`：已配置但**停用**——**不是** failed（是配置选择，不是故障）。
 *
 * 把这两个折叠进旧三态 = **谎报**（把"还在连"报成"连接失败"、把"人为关掉"报成"环境故障"）
 * ⇒ 线契约**两端同时**扩到五态：worker 的 `McpServerStatus`
 * （worker/src/protocol/worker-protocol.ts）+ 本文件的 `MCP_STATUS`/`@IsIn`。
 *
 * ⚠️ **升级顺序：先 server 后 worker**——本文件（server）先扩 ⇒ 老 worker 照常发三态，
 * 不受影响；worker 后扩。反过来（worker 先发五态、server 还是三态）⇒
 * `@IsIn` 拒收 → **整个心跳 400** → worker 被判离线。
 */
export const MCP_STATUS = {
  CONNECTED: 'connected',
  FAILED: 'failed',
  NEEDS_AUTH: 'needs_auth',
  PENDING: 'pending',
  DISABLED: 'disabled',
} as const;

export type McpStatus = (typeof MCP_STATUS)[keyof typeof MCP_STATUS];

/**
 * 心跳载荷中的单条 MCP 服务器状态（T8c）。
 * serverName 与 mcp_servers.name 对应；status 为 worker 探测结果
 * （connected / failed / needs_auth / pending / disabled）。
 */
export class McpStatusEntryDto {
  @ApiProperty({ description: 'MCP 服务器名称（与 mcp_servers.name 对应）' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  serverName: string;

  @ApiProperty({
    description:
      'MCP 服务器可用性（connected / failed / needs_auth / pending / disabled；' +
      '后两个是 v2 的瞬态/停用态，与 worker 侧 McpServerStatus 逐字对齐）',
    enum: Object.values(MCP_STATUS),
  })
  @IsIn(Object.values(MCP_STATUS))
  status: McpStatus;
}
