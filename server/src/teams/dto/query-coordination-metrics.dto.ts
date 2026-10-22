import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  COORDINATION_METRICS_DEFAULT_WINDOW_HOURS,
  COORDINATION_METRICS_MAX_WINDOW_HOURS,
} from '../coordination-metrics.constants';

/**
 * 协调度指标查询参数（批次 E）。
 *
 * 窗口形状固定为「右端点 + 长度」：`[to - windowHours, to]`。
 * - `to` 缺省 = 现在；显式传入可**复现历史窗口**（排障/对比两次体检时必需）。
 * - `windowHours` 缺省 168（7 天），上限 720（30 天）——超限直接 400，
 *   **绝不静默截断**（静默截断会让「我查了 30 天」与实际口径不一致，指标就废了）。
 */
export class QueryCoordinationMetricsDto {
  @ApiPropertyOptional({
    description:
      '统计窗口长度（小时）。1..720，缺省 168（7 天）；超上限直接 400，不静默截断',
    default: COORDINATION_METRICS_DEFAULT_WINDOW_HOURS,
    minimum: 1,
    maximum: COORDINATION_METRICS_MAX_WINDOW_HOURS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COORDINATION_METRICS_MAX_WINDOW_HOURS)
  windowHours?: number;

  @ApiPropertyOptional({
    description:
      '窗口右端点（ISO-8601 时间，缺省 = 现在）。显式传入可复现历史窗口',
  })
  @IsOptional()
  @IsString()
  @IsISO8601()
  to?: string;
}
