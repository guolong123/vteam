import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * PATCH /channels/:id 请求体（UX-09 会话管理）：
 * `{pinned: boolean}` 置顶（true）/取消置顶（false）。
 */
export class UpdateChannelDto {
  @ApiProperty({ description: '置顶标记：true 置顶 / false 取消置顶' })
  @IsBoolean()
  pinned: boolean;
}
