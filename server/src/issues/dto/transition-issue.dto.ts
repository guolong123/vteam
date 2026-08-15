import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ISSUE_TRANSITIONS } from '../issues.constants';

/**
 * POST /issues/:id/transition 请求体。
 * action ∈ {start, resolve, close, reopen, reject}，非法动作由 class-validator 400 拦截；
 * 合法但 from 不匹配当前状态由服务层 409 `ISSUE_INVALID_TRANSITION`；
 * action=reject 时 reason 必填（服务层校验 400 `ISSUE_REJECT_REASON_REQUIRED`，is_0000000013）。
 */
export class TransitionIssueDto {
  @ApiProperty({
    description: '状态流转动作',
    enum: Object.keys(ISSUE_TRANSITIONS),
  })
  @IsIn(Object.keys(ISSUE_TRANSITIONS))
  action: string;

  @ApiPropertyOptional({
    description: '拒绝原因（action=reject 时必填）',
    maxLength: 512,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}
