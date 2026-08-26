import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { NOTIFICATION_TYPES } from '../notification.constants';

export class UpdateNotificationChannelDto {
  @ApiPropertyOptional({ description: '渠道名称', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({
    description: '渠道类型',
    enum: Object.values(NOTIFICATION_TYPES),
  })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(NOTIFICATION_TYPES) as string[])
  type?: string;

  @ApiPropertyOptional({ description: '渠道配置对象（浅合并）', type: Object })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '敏感配置对象（浅合并，缺省 key 保留旧值）',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, unknown>;
}
