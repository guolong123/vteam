import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/** POST /auth/refresh 请求体（09 §3.1：{refreshToken}） */
export class RefreshDto {
  @ApiProperty({ description: 'refresh token' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
