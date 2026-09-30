import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MEMORY_LEVELS } from '../memory.constants';

/**
 * GET /memories 查询参数（level/teamId/autoInject 过滤 + keyword 内容搜索 + 分页，
 * 对齐 QueryToolsDto 模式，返回 {items, total, page, pageSize}）。
 * 全端点 AdminGuard（Metis m6：记忆管理仅管理员可见，不扩展权限矩阵）。
 * 2026-09-30：level 扩为 team/role/global（task 级记忆已删除，level=task → 400，
 * taskId 过滤已删除）；新增 autoInject 过滤（记忆页「仅看自动注入」）。
 */
export class QueryMemoriesDto {
  @ApiPropertyOptional({
    description: '记忆等级过滤（team/role/global），缺省返回全部',
    enum: Object.values(MEMORY_LEVELS),
  })
  @IsOptional()
  @IsIn(Object.values(MEMORY_LEVELS))
  level?: string;

  @ApiPropertyOptional({ description: '团队级过滤（teamId 精确匹配）' })
  @IsOptional()
  @IsString()
  teamId?: string;

  @ApiPropertyOptional({
    description: '岗位过滤（roleId 精确匹配，仅对 level=role 有意义）',
  })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiPropertyOptional({
    description:
      '自动注入过滤：true=仅参与每轮注入的记忆，false=仅按需检索的记忆；缺省不筛',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsIn([true, false])
  autoInject?: boolean;

  @ApiPropertyOptional({ description: '记忆内容模糊搜索（content contains）' })
  @IsOptional()
  @IsString()
  keyword?: string;

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

  @ApiPropertyOptional({
    description: '每页条数（默认 20，上限 100）',
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/**
 * PATCH /memories/:id 部分更新体（T4 记忆演进；2026-09-30 增 autoInject 开关）。
 * content/description/tags/autoInject 至少传一个（全空 → 400 MEMORY_UPDATE_EMPTY）；
 * content 更新时服务端同步重算 contentHash（精确去重键保持与正文一致）。
 * autoInject 是**单条记忆**的属性（记忆页行内开关），非团队/全局开关。
 */
export class UpdateMemoryDto {
  @ApiPropertyOptional({ description: '记忆正文（更新后重算去重键）' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  content?: string;

  @ApiPropertyOptional({ description: '记忆摘要（1~255 字符）' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({ description: '记忆标签（≤20 个，全量替换）' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  tags?: string[];

  @ApiPropertyOptional({
    description:
      '是否参与每轮自动注入（单条记忆属性）。true 时按 level 受众规则注入：team/global → 本团队主 Agent，role → 本团队该岗位全部 agent。false（默认）= 仅 memory_search 按需检索。',
    type: Boolean,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  autoInject?: boolean;
}
