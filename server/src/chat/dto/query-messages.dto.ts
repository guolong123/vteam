import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * GET /channels/:id/messages 查询参数（09 篇 §2.2/§3.5、10 篇 §6）：
 * 游标分页，游标即消息主键 id（字符串，数值序 == 字典序）。
 * - cursor：上一页最后一条消息 id（缺省 = 第一页，取最早 limit 条，id 升序）；
 * - limit：默认 50，上限 100。
 * 响应 `{items, nextCursor}`；末页 nextCursor=null。
 */
export class QueryMessagesDto {
  @ApiPropertyOptional({
    description: '游标 = 上页最后一条消息 id；缺省查第一页（最早 limit 条，id 升序）',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ description: '每页条数（默认 50，上限 100）', default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
