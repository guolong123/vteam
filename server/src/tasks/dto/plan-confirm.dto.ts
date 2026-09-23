import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /tasks/:id/plan/confirm 请求体（todo11 用户确认门 + 定稿门 + todo4 修订重评）。
 * finalize（pending_final→approved，用户显式定稿，幂等）；
 * confirm（缺省，approved→executing，幂等）；reject 需 reason
 * （approved/rejected→draft 打回，rejectReason 落库，版本号+1 轮次不变由轮次账本承接）；
 * revise 需 reason（executing/completed→draft 修订，版本号+1 轮次+1 重走完整 N/N 复评）。
 */
export class PlanConfirmDto {
  @ApiPropertyOptional({
    description:
      '确认动作：finalize=确认定稿，confirm=开始执行，reject=打回重修，revise=修订重评（缺省 confirm）',
    enum: ['finalize', 'confirm', 'reject', 'revise'],
  })
  @IsOptional()
  @IsIn(['finalize', 'confirm', 'reject', 'revise'])
  action?: 'finalize' | 'confirm' | 'reject' | 'revise';

  @ApiPropertyOptional({
    description:
      '打回/修订原因（action=reject/revise 时必填，落库 rejectReason）',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;

  @ApiPropertyOptional({
    description:
      '人工跳过评审（action=finalize/confirm 时有效，需 tasks.edit）。' +
      'true：允许把 draft/reviewing 直接推进（finalize→approved 或 confirm→executing），' +
      '缺定稿时同事务补 finalizedBy/finalizedAt 与冻结锚，系统消息留痕「人工跳过评审」。' +
      '用于评审链路走不通时的人工出口；缺省 false 保持严格前置态（非 approved/pending_final 报 409）。',
  })
  @IsOptional()
  @IsBoolean()
  skipReview?: boolean;
}
