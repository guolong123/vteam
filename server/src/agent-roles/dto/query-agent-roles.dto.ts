import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginatedQueryDto } from '../../common/dto/paginated-query.dto';

/**
 * GET /agent-roles 查询参数（type 过滤 + 分页，对齐 QueryAgentsDto / QueryExecutionPoliciesDto 模式）。
 */
export class QueryAgentRolesDto extends PaginatedQueryDto {
  @ApiPropertyOptional({
    description: '角色类型筛选（builtin/custom），缺省返回全部（内置优先）',
    enum: ['builtin', 'custom'],
  })
  @IsOptional()
  @IsIn(['builtin', 'custom'])
  type?: string;
}
