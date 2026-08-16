import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * GET /plans 查询参数（vteam-team-collaboration tc-review）。
 * taskId 必填：一任务一计划（plans.task_id @unique），按任务查计划头 + 子任务清单。
 */
export class QueryPlansDto {
  @ApiProperty({ description: '任务 id（按任务查询执行计划，一任务一计划）' })
  @IsString()
  @IsNotEmpty()
  taskId: string;
}
