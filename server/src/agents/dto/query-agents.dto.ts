import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PaginatedQueryDto } from '../../common/dto/paginated-query.dto';

/**
 * GET /agents 查询参数（type 过滤 + 分页，对齐 QueryProjectsDto 模式）。
 */
export class QueryAgentsDto extends PaginatedQueryDto {
  @ApiPropertyOptional({
    description: 'Agent 类型筛选（template/custom），缺省返回全部',
    enum: ['template', 'custom'],
  })
  @IsOptional()
  @IsIn(['template', 'custom'])
  type?: string;
}
