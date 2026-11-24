import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** POST /auth/workspace 请求体：切换当前工作空间。 */
export class SwitchWorkspaceDto {
  @ApiProperty({ description: '目标工作空间 id', example: 'ws_0000000001' })
  @IsString()
  @IsNotEmpty()
  workspaceId: string;
}
