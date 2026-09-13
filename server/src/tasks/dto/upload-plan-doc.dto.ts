import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * POST /tasks/:id/plan-docs 请求体：上传（覆盖）一份计划文档。
 *
 * 只做文件搬运——name 落成 `.opencode/plans/<name>`，content 原样写盘，不解析不改写。
 *
 * name 白名单与 worker 执行端 `PLAN_DOC_NAME_RE` 对齐（两处必须一致，否则会出现
 * "server 放行、worker 400"的割裂）：字母数字开头，其后仅字母数字/下划线/点/连字符，
 * 且必须是 .md。正则本身已排除路径分隔符与 `..`，无需再依赖 worker 侧兜底。
 *
 * content 上限 1MB（与 worker `MAX_PLAN_UPLOAD_BYTES` / maxBodyBytes 对齐）——
 * 在第 400/413 行之前拦住，避免超大请求体打到 worker。
 */
export const PLAN_DOC_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-]*\.md$/;
export const MAX_PLAN_DOC_CONTENT_BYTES = 1024 * 1024;

export class UploadPlanDocDto {
  @ApiProperty({
    description: '计划文件名（必须以 .md 结尾，仅字母数字/下划线/点/连字符）',
    example: 'refactor-plan.md',
  })
  @IsString()
  @MaxLength(128)
  @Matches(PLAN_DOC_NAME_PATTERN, {
    message: 'name 必须是 .md 文件名（字母数字开头，仅含字母数字/下划线/点/连字符）',
  })
  name!: string;

  @ApiProperty({ description: '计划正文（Markdown 原文，≤1MB）' })
  @IsString()
  @MinLength(1)
  content!: string;
}
