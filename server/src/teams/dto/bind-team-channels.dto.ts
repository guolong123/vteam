import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsString, IsOptional } from 'class-validator';

export class BindTeamMessageChannelsDto {
  @ApiProperty({
    description: '消息渠道 ID 列表（replace-all，传空数组清空）',
    type: [String],
    example: ['mc_0000000001'],
  })
  @IsArray()
  @IsString({ each: true })
  messageChannelIds: string[];

  @ApiPropertyOptional({
    description:
      '是否抢占：渠道已绑定其他团队时，缺省返回 409（前端弹确认框）；置 true 则先解绑其他团队再绑定本团队。' +
      '渠道为「独占」资源——入站时按绑定团队逐个派发（message-inbound.service.ts 对每个 teamId 循环写消息+派发），' +
      '一条渠道绑多个团队会导致同一条外部消息在多个群各触发一次会话。',
    type: Boolean,
  })
  @IsOptional()
  replaceExisting?: boolean;
}

export class BindTeamNotificationChannelsDto {
  @ApiProperty({
    description: '通知渠道 ID 列表（replace-all，传空数组清空）',
    type: [String],
    example: ['nc_0000000001'],
  })
  @IsArray()
  @IsString({ each: true })
  notificationChannelIds: string[];

  @ApiPropertyOptional({
    description:
      '同 BindTeamMessageChannelsDto.replaceExisting（渠道独占语义一致）',
    type: Boolean,
  })
  @IsOptional()
  replaceExisting?: boolean;
}
