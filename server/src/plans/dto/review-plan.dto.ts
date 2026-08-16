import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PLAN_STATUS } from '../plan.constants';

/**
 * PATCH /plans/:id/review 请求体（vteam-team-collaboration tc-review）。
 * verdict ∈ {approved, rejected}（非法结论由 class-validator 400 拦截）；
 * rejected 时 reason 必填（服务层校验 400 PLAN_STRUCTURE_INVALID，
 * 对齐 platform-mcp plan_review 的 zod refine + 服务层二次校验纵深防御）。
 */
export class ReviewPlanDto {
  @ApiProperty({
    description: '评审结论',
    enum: [PLAN_STATUS.approved, PLAN_STATUS.rejected],
  })
  @IsIn([PLAN_STATUS.approved, PLAN_STATUS.rejected])
  verdict: string;

  @ApiPropertyOptional({
    description: '评审说明（rejected 时必填）',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}
