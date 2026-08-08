import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** POST /projects 请求体（FR-25：创建者为主人 owner）。 */
export class CreateProjectDto {
  @ApiProperty({ description: '项目名（创建必填）', maxLength: 128 })
  @IsString()
  @MaxLength(128)
  name: string;

  @ApiPropertyOptional({ description: '项目描述（可选）' })
  @IsOptional()
  @IsString()
  description?: string;
}
