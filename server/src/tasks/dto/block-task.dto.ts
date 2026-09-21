import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * POST /tasks/:id/block 请求体。
 * reason 必填（卡点不明不许挂）：卡在哪里、缺什么、等谁，写入 task_events.metadata。
 */
export class BlockTaskDto {
  @ApiProperty({
    description: '阻塞原因（必填）：卡在哪里、缺什么、等谁',
    maxLength: 512,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  reason!: string;
}
