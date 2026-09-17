import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CompleteTaskDto {
  @ApiPropertyOptional({
    description:
      '强制通过完工预检（仅绕过 issue/计划未完成检查，不绕过状态机合法性；强制记录进 task_events.metadata）',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional({
    description: '强制原因（写入 task_events.metadata.forceReason）',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}
