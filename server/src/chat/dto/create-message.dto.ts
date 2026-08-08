import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * @ mention 输入（09 篇 §5.1 CreateMessageDto）：
 * - `{ type: 'agent', agentId }` 定向 @（FR-11），agentId 必须已在任务虚拟团队内
 *   （服务端二次校验，10 篇 §4.1）；
 * - `{ type: 'all' }` @all 广播（FR-12），服务端展开为当前团队全部未移除 Agent。
 *
 * 嵌套校验在服务层 ChatService.resolveMentions 中执行（union 型 + 需跨表查团队），
 * 此处仅保证 mentions 是数组。落库时保持原样语义（all 型原样存储，10 篇 §4.1）。
 */
export type MentionInput =
  | { type: 'agent'; agentId: string }
  | { type: 'all' };

/** POST /channels/:id/messages 请求体（09 篇 §5.1）。 */
export class CreateMessageDto {
  @ApiProperty({ description: '消息正文（@ 以纯文本书写，前端解析后随 mentions 提交）' })
  @IsString()
  @IsNotEmpty()
  text: string;

  @ApiPropertyOptional({
    description: '@ 引用数组（前端按正文解析）：{type:agent,agentId} 定向或 {type:all} 广播',
    type: 'array',
  })
  @IsOptional()
  @IsArray()
  mentions?: MentionInput[];
}
