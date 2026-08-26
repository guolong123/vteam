import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsString,
  IsNotEmpty,
  ArrayNotEmpty,
  IsOptional,
} from 'class-validator';

export class BindMessageChannelsDto {
  @ApiProperty({
    description: '消息渠道 ID 列表（replace-all，传空数组清空）',
    type: [String],
    example: ['mc_0000000001'],
  })
  @IsArray()
  @IsString({ each: true })
  messageChannelIds: string[];
}

export class BindNotificationChannelsDto {
  @ApiProperty({
    description: '通知渠道 ID 列表（replace-all，传空数组清空）',
    type: [String],
    example: ['nc_0000000001'],
  })
  @IsArray()
  @IsString({ each: true })
  notificationChannelIds: string[];
}
