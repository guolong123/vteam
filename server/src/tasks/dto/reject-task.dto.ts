import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /tasks/:id/reject 请求体（13 篇 §4.4）。
 * reason 写入 task_events.metadata（{ reason }），供 Agent 与成员在群聊可见。
 */
export class RejectTaskDto {
  @ApiPropertyOptional({
    description: '驳回原因（写入 task_events.metadata.reason）',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}
