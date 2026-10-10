import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { McpStatusEntryDto } from '../../mcp-servers/dto/mcp-status.dto';
import {
  WORKER_UPDATE_STATES,
  WorkerUpdateState,
} from '../worker-update-state';
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

  /**
   * worker 代码版本（worker-self-update Todo 2）：与 register 同字段同口径。
   * 旧 worker 不携带——**可选，缺席不报错、不清空已有值**（心跳缺席时保留
   * register 阶段上报的版本，而不是把「本次没说」误读成「没有版本」）。
   */
  @ApiPropertyOptional({
    description:
      'worker 代码版本（git 短 SHA / manual-<date> / dev）；旧 worker 缺省 = 保留上次上报值',
  })
  @IsOptional()
  @IsString()
  codeVersion?: string;

  /**
   * 自更新执行状态（与 register 同字段同口径，Todo 3 ↔ Todo 4 共享契约）。
   * 心跳是执行器的进度上报通道，故状态在心跳里刷新最快（下载中/重启中/待手动重启）。
   */
  @ApiPropertyOptional({
    description:
      '自更新执行状态（pending/downloading/restarting/ready-manual/rolledback）；旧 worker 缺省 = 未上报',
    enum: Object.values(WORKER_UPDATE_STATES),
  })
  @IsOptional()
  @IsIn(Object.values(WORKER_UPDATE_STATES))
  updateState?: WorkerUpdateState;

  /** 最近一次自更新是否已被自动回滚（缺席 = 未上报 → 不写列，显式 false 才落 false）。 */
  @ApiPropertyOptional({
    description:
      '最近一次自更新是否已被自动回滚（缺席 = 未上报，不覆盖已有值）',
  })
  @IsOptional()
  @IsBoolean()
  rolledBack?: boolean;
}
