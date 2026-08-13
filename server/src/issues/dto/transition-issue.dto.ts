import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { ISSUE_TRANSITIONS } from '../issues.constants';

/**
 * POST /issues/:id/transition 请求体。
 * action ∈ {start, resolve, close, reopen, reject}，非法动作由 class-validator 400 拦截；
 * 合法但 from 不匹配当前状态由服务层 409 `ISSUE_INVALID_TRANSITION`。
 */
export class TransitionIssueDto {
  @ApiProperty({
    description: '状态流转动作',
    enum: Object.keys(ISSUE_TRANSITIONS),
  })
  @IsIn(Object.keys(ISSUE_TRANSITIONS))
  action: string;
}
