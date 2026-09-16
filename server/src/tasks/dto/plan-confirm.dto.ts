import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /tasks/:id/plan/confirm 请求体（todo11 用户确认门 + 定稿门）。
 * finalize（pending_final→approved，用户显式定稿，幂等）；
 * confirm（缺省，approved→executing，幂等）；reject 需 reason
 * （approved→draft 打回，rejectReason 落库，版本号+1 轮次不变由轮次账本承接）。
 */
export class PlanConfirmDto {
  @ApiPropertyOptional({
    description: '确认动作：finalize=确认定稿，confirm=开始执行，reject=打回重修（缺省 confirm）',
    enum: ['finalize', 'confirm', 'reject'],
  })
  @IsOptional()
  @IsIn(['finalize', 'confirm', 'reject'])
  action?: 'finalize' | 'confirm' | 'reject';

  @ApiPropertyOptional({
    description: '打回原因（action=reject 时必填，落库 rejectReason）',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}
