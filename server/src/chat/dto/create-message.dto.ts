import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { MAX_MESSAGE_ATTACHMENTS } from '../message-attachments';

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
  | { type: 'agent'; agentId: string; instanceId?: string }
  | { type: 'all' }
  | { type: 'user'; userId: string };

/**
 * 消息附件输入（多附件，UX-10 扩展）：与 POST /uploads 响应 `{url,name,size,ext}` 同形。
 * - `url` 必填（/uploads/... 相对路径或外链 http(s)）；
 * - `name`/`ext`/`size` 可选：缺失时由服务端 normalizeAttachmentList 从 url/文件名派生
 *   （ext 缺失回落文件名后缀、size 缺失不落 0）。
 *
 * 校验只做「形状 + 数量」，不做 URL 可访问性检查（上传白名单/大小由 /uploads 兜底）。
 * 归一化/去重/截断在服务层经 message-attachments helper 统一完成，禁止在此重复实现。
 */
export class MessageAttachmentDto {
  @ApiProperty({
    description:
      '附件可访问 URL（POST /uploads 返回的相对路径，如 /uploads/<uuid>.png）',
  })
  @IsString()
  url: string;

  @ApiPropertyOptional({ description: '附件原始文件名（含扩展名）' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: '附件扩展名（小写，如 png/pdf；缺失时服务端从文件名派生）',
  })
  @IsOptional()
  @IsString()
  ext?: string;

  @ApiPropertyOptional({ description: '附件字节数（拿不到字节数时缺省）' })
  @IsOptional()
  @IsNumber()
  size?: number;
}

/** POST /channels/:id/messages 请求体（09 篇 §5.1）。 */
export class CreateMessageDto {
  @ApiProperty({
    description:
      '消息正文（@ 以纯文本书写，前端解析后随 mentions 提交；纯附件消息可为空串）',
  })
  @IsString()
  text: string;

  @ApiPropertyOptional({
    description:
      '@ 引用数组（前端按正文解析）：{type:agent,agentId} 定向或 {type:all} 广播',
    type: 'array',
  })
  @IsOptional()
  @IsArray()
  mentions?: MentionInput[];

  // UX-10 群聊附件（多附件）：客户端先 POST /uploads（multipart file）拿
  // {url,name,size,ext}，再随消息提交 attachments 数组（≤MAX_MESSAGE_ATTACHMENTS）。
  // 服务端不单独校验 URL 可访问性：静态服务 /uploads/* 由 main.ts 挂载，上传
  // 白名单已兜底类型/大小。
  @ApiPropertyOptional({
    description:
      `消息附件数组（最多 ${MAX_MESSAGE_ATTACHMENTS} 个；元素为 POST /uploads 返回的 ` +
      '{url,name,size,ext}，name/ext/size 可缺省由服务端派生）',
    type: [MessageAttachmentDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MESSAGE_ATTACHMENTS)
  @ValidateNested({ each: true })
  @Type(() => MessageAttachmentDto)
  attachments?: MessageAttachmentDto[];

  // 兼容旧契约（单附件）：三字段 = attachments 只有一个元素时的等价写法。
  // 服务端统一经 normalizeMessageAttachments 归一化（新数组优先、三字段回退单元素），
  // 落库时按「新列 + 旧三字段=首个附件」双写，旧前端/旧 MCP 消费者不受影响。
  @ApiPropertyOptional({
    description:
      '附件可访问 URL（旧单附件契约；等价于 attachments 只含一个元素，建议新客户端改用 attachments）',
  })
  @IsOptional()
  @IsString()
  attachmentUrl?: string;

  @ApiPropertyOptional({ description: '附件原始文件名（含扩展名）' })
  @IsOptional()
  @IsString()
  attachmentName?: string;

  @ApiPropertyOptional({
    description: '附件扩展名（小写，如 png/pdf，供前端判定图片内嵌或文件下载）',
  })
  @IsOptional()
  @IsString()
  attachmentType?: string;

  @ApiPropertyOptional({
    description:
      '外部会话地址（企微：群聊 chatid / 私聊发送者 userid）：出站主动推送按它锚定目标会话，避免多群/多人共用 bot 时错投',
  })
  @IsOptional()
  @IsString()
  externalChatId?: string;

  @ApiPropertyOptional({ description: '任务分区 id（team_group 频道分区）' })
  @IsOptional()
  @IsString()
  taskId?: string;
}
