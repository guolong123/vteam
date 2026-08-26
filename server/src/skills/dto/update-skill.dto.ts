import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * PATCH /skills/:id 请求体（UX-15 技能编辑，JSON body，非 multipart）。
 * 三字段全部可选：name/description 编辑元信息（同步重写 content frontmatter），
 * content 编辑 SKILL.md 全文（经 parseSkillMarkdown 校验并反向同步列）。
 * 至少提供一个字段，全空 → 400 SKILL_UPDATE_EMPTY（service 层校验）。
 */
export class UpdateSkillDto {
  @ApiPropertyOptional({
    description: '技能名（小写字母数字中划线 slug，如 git-ops）',
    example: 'git-ops-v2',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '技能描述' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description:
      'SKILL.md 全文（含 frontmatter；后端校验合法并同步 name/description 列）',
  })
  @IsOptional()
  @IsString()
  content?: string;
}
