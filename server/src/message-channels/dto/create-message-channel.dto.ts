import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MESSAGE_CHANNEL_TYPES } from '../message-channel.constants';

export class CreateMessageChannelDto {
  @ApiProperty({
    description: '渠道名称',
    maxLength: 64,
    example: 'my-webhook',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;

  @ApiProperty({
    description: '渠道类型',
    enum: Object.values(MESSAGE_CHANNEL_TYPES),
    example: 'generic_webhook',
  })
  @IsString()
  @IsIn(Object.values(MESSAGE_CHANNEL_TYPES) as string[])
  type: string;

  @ApiPropertyOptional({
    description: '渠道配置对象',
    type: Object,
    example: {},
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '敏感配置对象（写入后只读，GET 掩码）',
    type: Object,
    example: {},
  })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, unknown>;
}
