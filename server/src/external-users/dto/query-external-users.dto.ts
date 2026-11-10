import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * GET /external-users 查询参数（契约 §2.1）。
 *
 * keyword 在服务层 trim 后对 name/displayName/company/position/contact/
 * externalId 做 contains 匹配（MySQL 默认排序规则大小写不敏感）。
 * 外部用户量级小，分页在服务层内存里做（先按邀请时间统计排序再切片）。
 */
export class QueryExternalUsersDto {
  @ApiPropertyOptional({
    description:
      '关键字：姓名/渠道展示名/公司/岗位/联系方式/外部标识 模糊匹配（trim 后 contains）',
  })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({
    description: '页码（从 1 起）',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: '每页条数（1-100）',
    default: 50,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/**
 * GET /external-users/:id/messages 查询参数（契约 §2.4）。
 *
 * 与 GET /channels/:id/messages 同口径的游标分页：cursor = 上一页**最早**一条
 * 消息 id，缺省取最新 limit 条；items 始终 id 升序（时间正序）。
 * 默认 limit 与频道消息接口（50）不同，本接口按契约用 30。
 */
export class QueryExternalUserMessagesDto {
  @ApiPropertyOptional({
    description: '游标 = 上页最早一条消息 id；缺省查第一页（最新 limit 条）',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: '每页条数（默认 30，上限 100）',
    default: 30,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
