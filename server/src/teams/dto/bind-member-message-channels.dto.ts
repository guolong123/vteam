import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * 绑定入站消息渠道到**团队成员**（2026-11-13）。
 *
 * 绑定后该渠道收到的消息直达该成员私聊并触发执行，不再进团队群聊。
 * `replace-all` 语义：传空数组即清空该成员的全部渠道绑定。
 */
export class BindMemberMessageChannelsDto {
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
      '是否抢占：渠道已被其他团队或成员绑定时，缺省返回 409（前端弹确认框）；置 true 则先解绑再绑定到本成员。',
    type: Boolean,
  })
  @IsOptional()
  replaceExisting?: boolean;
}
