import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * GET /channels/:id/messages 查询参数（09 篇 §2.2/§3.5、10 篇 §6）：
 * 游标分页，游标即消息主键 id（字符串，数值序 == 字典序）。
 * - cursor：上一页**最早**一条消息 id（缺省 = 第一页，取**最新** limit 条）；
 * - limit：默认 50，上限 100。
 * 响应 `{items, nextCursor}`：items 始终 id 升序（时间正序）；nextCursor = 当前页最早一条 id
 * （下一页取更老）；末页 nextCursor=null。
 */
export class QueryMessagesDto {
  @ApiPropertyOptional({
    description:
      '游标 = 上页最早一条消息 id；缺省查第一页（最新 limit 条，items id 升序）；下一页取更老',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: '每页条数（默认 50，上限 100）',
    default: 50,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * 仅 `GET /channels/:id/session-history` 使用：群聊频道下指定「看哪个成员的会话」。
   *
   * 背景（2026-11-10）：群聊里点成员头像此前只是对群聊消息做一次筛选，而群聊消息
   * 是平台消息表投影（text + 已落库 parts），拿不到该成员**完整的思考/工具调用**过程。
   * 传入席位 id（tmm_）后，服务端按 `session.team_member_id` 定位该成员的会话，
   * 复用私聊同一条 serve 拉取链路，返回含 reasoning/tool 的完整历史。
   *
   * 私聊频道忽略此参数（本来就按频道自身的 teamMemberId 定位）。
   */
  @ApiPropertyOptional({
    description:
      '群聊下指定成员席位 id（tmm_）：返回该成员的完整会话历史（含思考/工具）。私聊忽略',
  })
  @IsOptional()
  @IsString()
  teamMemberId?: string;
}
