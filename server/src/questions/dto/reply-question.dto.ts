import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional } from 'class-validator';
import { PERMISSION_RESPONSES } from '../questions.constants';

/**
 * POST /questions/:id/reply 请求体（用户对模型 question / 工具权限确认的回复）。
 * - question：answers（label 数组，顺序对应 questions；null=拒绝）
 * - permission：response（once|always|reject）
 * - secret_input：secrets（{变量名: 值}；null=取消）
 */
export class ReplyQuestionDto {
  @ApiProperty({
    description:
      'question 答复：Array<Array<string>>（label 数组，顺序对应 questions）；null=拒绝',
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
    required: false,
    nullable: true,
  })
  @IsOptional()
  answers?: string[][] | null;

  @ApiProperty({
    description: 'permission 确认：once|always|reject',
    enum: PERMISSION_RESPONSES,
    required: false,
  })
  @IsOptional()
  @IsIn(PERMISSION_RESPONSES)
  response?: (typeof PERMISSION_RESPONSES)[number];

  @ApiProperty({
    description:
      'secret_input 答复：{变量名: 值}（值仅经内存传给执行钩子，不落库不回显）；null=取消（不执行命令）',
    type: 'object',
    additionalProperties: { type: 'string' },
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, string> | null;
}
