import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

/** GET /conversations 查询参数（类型/关键字/只看未读）。 */
export class QueryConversationsDto {
  @ApiPropertyOptional({
    description: '类型过滤：group=群聊，dm=成员私聊；缺省全部',
    enum: ['group', 'dm'],
  })
  @IsOptional()
  @IsIn(['group', 'dm'])
  type?: 'group' | 'dm';

  @ApiPropertyOptional({ description: '关键字：群名 / 成员名' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ description: '只看有未读的会话', type: Boolean })
  @IsOptional()
  @IsIn([true, false])
  unreadOnly?: boolean;
}
