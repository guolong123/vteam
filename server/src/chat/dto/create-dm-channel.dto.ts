import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/** POST /dm-channels 请求体（09 篇 §3.5 Chat FR-14）：创建 private 私聊频道。 */
export class CreateDmChannelDto {
  @ApiProperty({
    description:
      '所属任务 id（私聊频道 task_id 关联，与群聊共用该 Agent 会话）',
  })
  @IsString()
  @IsNotEmpty()
  taskId: string;

  @ApiProperty({
    description: '私聊对象 Agent id（type=private，task_id+agent_id 唯一）',
  })
  @IsString()
  @IsNotEmpty()
  agentId: string;

  /** T6 实例语义：私聊目标实例 id（TaskAgent.id，ta_ 前缀）。同 agent 多实例时
   * 按 (taskId, taskAgentId) 幂等——开发者-1/开发者-2 各自独立私聊频道。 */
  @ApiPropertyOptional({
    description: '私聊目标实例 id（ta_ 前缀；同 agent 多实例时必传以区分频道）',
  })
  @IsOptional()
  @IsString()
  taskAgentId?: string;
}
