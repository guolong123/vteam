import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { MEMBER_STATUS } from '../members.constants';
import { PaginatedQueryDto } from '../../common/dto/paginated-query.dto';

/** GET /members 查询参数（keyword/roleId/status + 分页）。 */
export class QueryMembersDto extends PaginatedQueryDto {
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
}
