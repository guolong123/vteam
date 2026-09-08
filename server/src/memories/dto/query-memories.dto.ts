import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MEMORY_LEVELS } from '../memory.constants';

/**
 * GET /memories 查询参数（level/teamId 过滤 + keyword 内容搜索 + 分页，
 * 对齐 QueryToolsDto 模式，返回 {items, total, page, pageSize}）。
 * 全端点 AdminGuard（Metis m6：记忆管理仅管理员可见，不扩展权限矩阵）。
 * session-unification Todo 9：仅 team/global（任务级记忆已删除，level=task → 400，
 * taskId 过滤已删除）。
 */
export class QueryMemoriesDto {
  @ApiPropertyOptional({
    description: '记忆等级过滤（team/global），缺省返回全部',
    enum: Object.values(MEMORY_LEVELS),
  })
  @IsOptional()
  @IsIn(Object.values(MEMORY_LEVELS))
  level?: string;

  @ApiPropertyOptional({ description: '团队级过滤（teamId 精确匹配）' })
  @IsOptional()
  @IsString()
  teamId?: string;

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
