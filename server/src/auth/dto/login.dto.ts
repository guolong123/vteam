import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** POST /auth/login 请求体（09 §3.1：{username, password}） */
export class LoginDto {
  @ApiProperty({ description: '登录名', example: 'alice' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  username: string;

  @ApiProperty({ description: '明文密码', example: 'passw0rd' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}
