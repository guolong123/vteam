import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { McpStatusEntryDto } from '../../mcp-servers/dto/mcp-status.dto';
import { WorkerLoadDto } from './register-worker.dto';

export const WORKER_HEALTH = {
  ok: 'ok',
  degraded: 'degraded',
} as const;

export type WorkerHealth = (typeof WORKER_HEALTH)[keyof typeof WORKER_HEALTH];

/**
 * POST /workers/:id/heartbeat 请求体（架构决策 D1：10s 心跳，30s=3 周期超时判 offline）。
 * health 仅 ok/degraded：degraded 供 server 侧调度器降权，不改变 offline 判定。
 */
export class HeartbeatWorkerDto {
  @ApiProperty({ description: 'worker 全局唯一 id（w_ 前缀）' })
  @IsString()
  @IsNotEmpty()
  workerId: string;

  @ApiProperty({ description: '当前负载快照', type: WorkerLoadDto })
  @ValidateNested()
  @Type(() => WorkerLoadDto)
  load: WorkerLoadDto;

  @ApiProperty({ description: '健康状态', enum: Object.values(WORKER_HEALTH) })
  @IsIn(Object.values(WORKER_HEALTH))
  health: WorkerHealth;

  @ApiPropertyOptional({
    description: 'MCP 服务器三态快照（T8c：worker 节流探测结果，可选）',
    type: [McpStatusEntryDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => McpStatusEntryDto)
  mcpStatus?: McpStatusEntryDto[];
}
