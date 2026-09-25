import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { TRIGGER_KIND } from '../../common/constants/trigger.constants';
import { TRIGGER_STATUS } from '../trigger.service';

/**
 * GET /triggers 查询参数（scope/status/kind/team/task 过滤 + 分页，
 * 对齐 QueryToolsDto 模式，返回 {items, total, page, pageSize}）。
 *
 * 非法 status/kind 由 @IsIn 拦成 400（不进 service、不 500）；
 * teamId/taskId 走 payload JSON 精确匹配（当前排期方均写 payload.teamId，
 * 见 platform-mcp scheduleReceiptNudge/scheduleReviewRoundTimeout）。
 */
export class QueryTriggersDto {
  @ApiPropertyOptional({ description: '归属域类型过滤（精确匹配）' })
  @IsOptional()
  @IsString()
  scopeType?: string;

  @ApiPropertyOptional({
    description: '归属 id 过滤（精确匹配，SQL 注入无关：参数化查询）',
  })
  @IsOptional()
  @IsString()
  scopeId?: string;

  @ApiPropertyOptional({ description: '任务过滤（payload.taskId 精确匹配）' })
  @IsOptional()
  @IsString()
  taskId?: string;

  @ApiPropertyOptional({
    description:
      '团队过滤（payload.teamId 精确匹配；成员调用必填，无 teamId 全局列表仅管理员可见）',
  })
  @IsOptional()
  @IsString()
  teamId?: string;

  @ApiPropertyOptional({
    description:
      '状态过滤（pending|firing|fired|cancelled|failed），非法值 400',
    enum: Object.values(TRIGGER_STATUS),
  })
  @IsOptional()
  @IsIn(Object.values(TRIGGER_STATUS))
  status?: string;

  @ApiPropertyOptional({
    description: 'kind 过滤（TRIGGER_KIND 白名单 6 种），非法值 400',
    enum: Object.values(TRIGGER_KIND),
  })
  @IsOptional()
  @IsIn(Object.values(TRIGGER_KIND))
  kind?: string;

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
    description: '每页条数（1..100）',
    default: 20,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
