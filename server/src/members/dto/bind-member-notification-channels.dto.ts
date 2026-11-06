import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

/** PUT /members/:id/notification-channels：replace-all 绑定成员通知渠道。 */
export class BindMemberNotificationChannelsDto {
  @ApiProperty({
    description: '通知渠道 id 数组（nc_），replace-all',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  notificationChannelIds: string[];

  @ApiPropertyOptional({
    description:
      '渠道已绑定到其他团队/成员时是否转移归属（默认 false → 409 CHANNEL_ALREADY_BOUND）',
  })
  @IsOptional()
  @IsBoolean()
  replaceExisting?: boolean;
}
