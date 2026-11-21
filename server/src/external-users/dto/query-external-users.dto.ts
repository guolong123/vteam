import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { createPaginatedQueryDto } from '../../common/dto/paginated-query.dto';
import { EXTERNAL_USERS_DEFAULT_PAGE_SIZE } from '../constants';

/**
 * GET /external-users 查询参数（契约 §2.1）。
 *
 * keyword 在服务层 trim 后对 name/displayName/company/position/contact/
 * externalId 做 contains 匹配（MySQL 默认排序规则大小写不敏感）。
 * 外部用户量级小，分页在服务层内存里做（先按邀请时间统计排序再切片）。
 */
/**
 * 本端点契约的 `pageSize` 默认值是 **50**（其余列表端点均为 20），上限 100。
 * 特化基类由 `createPaginatedQueryDto` 生成，字段装饰器与手写完全等价。
 */
class ExternalUsersPaginatedQueryDto extends createPaginatedQueryDto({
  defaultPageSize: EXTERNAL_USERS_DEFAULT_PAGE_SIZE,
  maxPageSize: 100,
}) {}

export class QueryExternalUsersDto extends ExternalUsersPaginatedQueryDto {
  @ApiPropertyOptional({
    description:
      '关键字：姓名/渠道展示名/公司/岗位/联系方式/外部标识 模糊匹配（trim 后 contains）',
  })
  @IsOptional()
  @IsString()
  keyword?: string;
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
