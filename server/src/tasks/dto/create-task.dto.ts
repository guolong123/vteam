import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { TASK_PRIORITY } from '../../common/constants/task.constants';

/**
 * POST /projects/:pid/tasks 请求体（09 篇 §3.4 Tasks 创建）。
 * agentIds[] 为初始虚拟团队；mainAgentId 须在 agentIds 内（服务层校验，FR-08）。
 */
export class CreateTaskDto {
  @ApiProperty({ description: '任务标题（创建必填）', maxLength: 128 })
  @IsString()
  @MaxLength(128)
  title: string;

  @ApiPropertyOptional({ description: '任务描述（可选）' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: '优先级（high/medium/low，默认 medium）',
    enum: Object.values(TASK_PRIORITY),
    default: TASK_PRIORITY.medium,
  })
  @IsOptional()
  @IsIn(Object.values(TASK_PRIORITY))
  priority?: string;

  @ApiProperty({ description: '初始虚拟团队 Agent id 列表（FR-02）' })
  @IsArray()
  @IsString({ each: true })
  @ArrayNotEmpty()
  agentIds: string[];

  @ApiPropertyOptional({
    description: '主 Agent id（FR-08），须在 agentIds 内',
  })
  @IsOptional()
  @IsString()
  mainAgentId?: string;

  @ApiPropertyOptional({
    description: '背景文档元数据数组（FR-06，存 tasks.background_docs Json）',
  })
  @IsOptional()
  @IsArray()
  backgroundDocs?: unknown[];
}
