import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class EnqueueTaskDto {
  @ApiProperty({
    description: '待排队任务 id（须为该团队 pending 非队首任务）',
  })
  @IsString()
  @IsNotEmpty()
  taskId: string;
}
