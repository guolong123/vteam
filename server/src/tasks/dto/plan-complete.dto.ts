import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * PATCH /tasks/:id/plan/complete 请求体（todo11 完工标记）。
 * 主实例路径传 instanceId（须等于团队主成员，否则 403）；
 * 缺省为用户 PM 路径（tasks.review 权限守卫）。
 */
export class PlanCompleteDto {
  @ApiPropertyOptional({
    description: '主实例 id（主实例路径鉴权；缺省为用户 PM 路径）',
  })
  @IsOptional()
  @IsString()
  instanceId?: string;
}
