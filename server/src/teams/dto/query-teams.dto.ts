import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginatedQueryDto } from '../../common/dto/paginated-query.dto';

export class QueryTeamsDto extends PaginatedQueryDto {
  @ApiPropertyOptional({ description: '按名称搜索（contains）' })
  @IsOptional()
  @IsString()
  name?: string;
}
