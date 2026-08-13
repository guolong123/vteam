import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * POST /issues 请求体（issue-management plan todo 2）。
 * issue 仅任务绑定（taskId 必填，不做项目级 issue）；tags 为自由字符串标签数组。
 */
export class CreateIssueDto {
  @ApiProperty({ description: '任务 id（issue 仅任务绑定，必填）' })
  @IsString()
  taskId: string;

  @ApiProperty({ description: 'issue 标题（创建必填）', maxLength: 128 })
  @IsString()
  @MaxLength(128)
  title: string;

  @ApiPropertyOptional({ description: 'issue 描述（可选）' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: '标签（字符串数组，如 需求/缺陷/优化）',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description: '指派 Agent id（须在任务团队未 removed，服务层校验）',
  })
  @IsOptional()
  @IsString()
  assigneeAgentId?: string;

  @ApiPropertyOptional({ description: '指派用户 id（可选）' })
  @IsOptional()
  @IsString()
  assigneeUserId?: string;
}
