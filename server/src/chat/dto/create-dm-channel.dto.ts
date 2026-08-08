import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** POST /dm-channels 请求体（09 篇 §3.5 Chat FR-14）：创建 private 私聊频道。 */
export class CreateDmChannelDto {
  @ApiProperty({ description: '所属任务 id（私聊频道 task_id 关联，与群聊共用该 Agent 会话）' })
  @IsString()
  @IsNotEmpty()
  taskId: string;

  @ApiProperty({ description: '私聊对象 Agent id（type=private，task_id+agent_id 唯一）' })
  @IsString()
  @IsNotEmpty()
  agentId: string;
}
