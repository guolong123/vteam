import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { EXECUTION_MODES } from '../../plans/plan.constants';

/**
 * PATCH /tasks/:id/execution-mode 请求体（tc-flow）：切换任务执行模式。
 */
export class UpdateExecutionModeDto {
  @ApiProperty({
    description: '目标执行模式（direct/plan）',
    enum: Object.values(EXECUTION_MODES),
  })
  @IsIn(Object.values(EXECUTION_MODES))
  mode: string;
}
