import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { NOTIFICATION_TYPES } from '../notification.constants';

export class CreateNotificationChannelDto {
  @ApiProperty({
    description: '渠道名称',
    maxLength: 64,
    example: 'my-notify',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiProperty({
    description: '渠道类型',
    enum: Object.values(NOTIFICATION_TYPES),
    example: 'webhook',
  })
  @IsString()
  @IsIn(Object.values(NOTIFICATION_TYPES) as string[])
  type: string;

  @ApiProperty({
    description: '渠道配置对象（webhook 需 targetUrl，events 必填）',
    type: Object,
    example: {
      targetUrl: 'https://example.com/hook',
      events: ['task.status_changed'],
    },
  })
  @IsObject()
  config: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '敏感配置对象（写入后只读，GET 掩码）',
    type: Object,
    example: {},
  })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, unknown>;
}
