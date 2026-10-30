import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  STATS_DEFAULT_GRANULARITY,
  STATS_DEFAULT_WINDOW_DAYS,
  STATS_GRANULARITIES,
  STATS_MAX_WINDOW_DAYS,
  type StatsGranularity,
} from '../stats.constants';

/** 日期形状 `YYYY-MM-DD`（本地日历日，非 ISO 时间戳）。 */
export const STATS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 统计查询参数（两种端点共用）。
 *
 * 窗口形状固定为「右端点 + 天数」而不是 from/to 两个绝对时间：
 * - 运营者的真实问题是「近 7/30/90 天怎么样」，用天数直接对上原型的三个区间预设；
 * - `to` 缺省 = 今天（Asia/Shanghai 日切）；显式传入可**复现历史窗口**（排障/对比必需）；
 * - `days` 缺省 30，上限 90，超限直接 400——**绝不静默截断**。
 *
 * ⚠️ `days` 与 `granularity` 的组合由 service 校验（例如「近 7 天 + 月粒度」只会得到
 * 1 个桶，服务照常返回 1 个桶，由前端呈现「粒度大于区间」的空态，不在这里报 400）。
 */
export class QueryStatsDto {
  @ApiPropertyOptional({
    description: `统计窗口天数。1..${STATS_MAX_WINDOW_DAYS}，缺省 ${STATS_DEFAULT_WINDOW_DAYS}；超上限直接 400`,
    default: STATS_DEFAULT_WINDOW_DAYS,
    minimum: 1,
    maximum: STATS_MAX_WINDOW_DAYS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(STATS_MAX_WINDOW_DAYS)
  days?: number;

  @ApiPropertyOptional({
    description:
      '时间粒度：day / week / month（缺省 day）。只影响桶切分，不影响总量口径',
    default: STATS_DEFAULT_GRANULARITY,
    enum: STATS_GRANULARITIES,
  })
  @IsOptional()
  @IsString()
  @IsIn(STATS_GRANULARITIES)
  granularity?: StatsGranularity;

  @ApiPropertyOptional({
    description:
      '窗口右端点（本地日历日 YYYY-MM-DD，缺省 = 今天 Asia/Shanghai）。显式传入可复现历史窗口',
    example: '2026-10-30',
  })
  @IsOptional()
  @IsString()
  @Matches(STATS_DATE_PATTERN, {
    message: 'to 须为 YYYY-MM-DD 形状的本地日历日',
  })
  to?: string;
}

/**
 * 全局看板查询参数 = 通用参数 + 团队过滤。
 *
 * `teamIds` 为逗号分隔的团队 id 列表（缺省 = 全部团队）。用逗号串而非重复 query key，
 * 是为了让 `?teamIds=a,b` 这种人类可读的 URL 可直接复现，且各 HTTP 客户端一致。
 */
export class QueryStatsOverviewDto extends QueryStatsDto {
  @ApiPropertyOptional({
    description:
      '团队过滤：逗号分隔的团队 id（缺省 = 全部团队）。示例 `tm_0000000001,tm_0000000002`',
    example: 'tm_0000000001,tm_0000000002',
  })
  @IsOptional()
  @IsString()
  teamIds?: string;
}
