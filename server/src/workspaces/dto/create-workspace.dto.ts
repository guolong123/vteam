import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** POST /workspaces 请求体。 */
export class CreateWorkspaceDto {
  @ApiProperty({
    description: '空间名称（同一 owner 下唯一）',
    example: '我的空间',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name: string;
}
