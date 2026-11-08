import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MEMBER_STATUS } from '../members.constants';

/** GET /members 查询参数（keyword/roleId/status + 分页）。 */
export class QueryMembersDto {
  @ApiPropertyOptional({ description: '关键字：成员名 / Agent 名模糊匹配' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ description: '默认岗位 id 过滤' })
  @IsOptional()
  @IsString()
  roleId?: string;

  @ApiPropertyOptional({
    description: '状态过滤',
    enum: [MEMBER_STATUS.active, MEMBER_STATUS.disabled],
  })
  @IsOptional()
  @IsIn([MEMBER_STATUS.active, MEMBER_STATUS.disabled])
  status?: string;

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
    description: '每页条数（1-100）',
    default: 20,
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
