import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ARTIFACT_CATEGORIES, ARTIFACT_TYPES } from '../artifacts.constants';

/**
 * POST /tasks/:id/artifacts 旁路提交 body（09 篇 §3.6，P1 辅助入口）。
 * type/title 由全局 ValidationPipe 校验；content/fileRef 交叉约束
 * （text→content 必填；doc/file→fileRef 必填）在 ArtifactsService 协议校验兜底。
 */
export class CreateArtifactDto {
  @ApiProperty({ description: '产出物类型', enum: ARTIFACT_TYPES })
  @IsIn(ARTIFACT_TYPES)
  type: (typeof ARTIFACT_TYPES)[number];

  @ApiProperty({ description: '产出物标题（必填非空）' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({
    description: '内容（type=text 必填；doc/file 时作为 contentRef 兜底）',
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    description: '文件引用 URL（type=doc/file 必填；12 篇 §3.1 fileRef）',
  })
  @IsOptional()
  @IsString()
  fileRef?: string;

  @ApiPropertyOptional({
    description:
      '分类标签（需求/设计/实现/测试用例/测试报告/运维/其他，可选；缺省为未分类 NULL）',
    enum: ARTIFACT_CATEGORIES,
  })
  @IsOptional()
  @IsIn(ARTIFACT_CATEGORIES)
  category?: string;
}

/** GET /tasks/:id/artifacts 查询参数（type/accepted 筛选 + 分页，对齐 QueryTasksDto 模式）。 */
export class QueryArtifactsDto {
  @ApiPropertyOptional({
    description: '产出物类型筛选（text/doc/file/plan），缺省返回全部',
    enum: ARTIFACT_TYPES,
  })
  @IsOptional()
  @IsIn(ARTIFACT_TYPES)
  type?: string;

  @ApiPropertyOptional({
    description: '验收状态筛选（true/false，按当前版本 acceptedFlag）',
    enum: ['true', 'false'],
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  accepted?: string;

  @ApiPropertyOptional({
    description: '分类筛选（七类中文词表其一；未传返回全部含未分类）',
    enum: ARTIFACT_CATEGORIES,
  })
  @IsOptional()
  @IsIn(ARTIFACT_CATEGORIES)
  category?: string;

  @ApiPropertyOptional({
    description: '页码（从 1 起）',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数', default: 20, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

/** POST /artifacts/:id/restore body（T5 append-as-new：历史版本复制为新当前版本）。 */
export class RestoreArtifactDto {
  @ApiProperty({ description: '待恢复的历史版本号（从 1 起）', minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}
