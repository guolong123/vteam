import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginatedQueryDto } from '../../common/dto/paginated-query.dto';

/**
 * GET /execution-policies 查询参数（type 过滤 + 分页，对齐 QueryAgentsDto 模式）。
 */
export class QueryExecutionPoliciesDto extends PaginatedQueryDto {
  @ApiPropertyOptional({
    description: '策略类型筛选（template/custom），缺省返回全部',
    enum: ['template', 'custom'],
  })
  @IsOptional()
  @IsIn(['template', 'custom'])
  type?: string;
}
