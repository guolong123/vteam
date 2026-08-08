import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** 工具来源枚举（对齐 /skills 工具 Tab 三子 Tab：builtin 内置 / custom 自定义 / mcp）。 */
export const TOOL_SOURCES = ['builtin', 'custom', 'mcp'] as const;
export type ToolSource = (typeof TOOL_SOURCES)[number];

/** 执行方式枚举（对齐 tool-register 表单 4 种执行形态：code/cli/http/mcp）。 */
export const TOOL_EXECUTIONS = ['code', 'cli', 'http', 'mcp'] as const;
export type ToolExecution = (typeof TOOL_EXECUTIONS)[number];

/**
 * POST /tools 请求体（09 §3.8 契约对齐：{name, execution, schema?, initCommand?, mcpServer?}，
 * **无独立 source 入参**——service 按 execution 推导：mcp→mcp，其余→custom；
 * builtin 走 seed 数据）。
 * action 全局唯一（schema.prisma @@unique），冲突 → 409 TOOL_ACTION_EXISTS。
 */
export class CreateToolDto {
  @ApiProperty({ description: '工具名称（展示名，如 Jira 查询）', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  name: string;

  @ApiProperty({
    description: '工具调用标识（唯一，小写 slug，如 jira-query）',
    example: 'jira-query',
    maxLength: 64,
  })
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9][a-z0-9-_.]*$/, {
    message: 'action 需为小写字母/数字/连字符/下划线/点开头（如 jira-query）',
  })
  action: string;

  @ApiProperty({ description: '执行方式（4 形态）', enum: TOOL_EXECUTIONS })
  @IsIn(TOOL_EXECUTIONS)
  execution: ToolExecution;

  @ApiPropertyOptional({
    description: 'MCP server 标识（execution=mcp 时必填，如 filesystem）',
  })
  @IsOptional()
  @IsString()
  mcpServer?: string;

  @ApiPropertyOptional({
    description: '输入/输出 JSON Schema（execution=mcp 时 server 自带，可不传）',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  schema?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      '初始化命令/脚本列表（Json 数组，如 [{script, note}]，CLI/MCP 形态使用）',
    type: [Object],
  })
  @IsOptional()
  @IsArray()
  initCommand?: Array<Record<string, unknown>>;

  @ApiPropertyOptional({ description: '是否启用', default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
