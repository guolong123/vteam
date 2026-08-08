import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** POST /auth/register 请求体（09 §3.1：{username, password, displayName, email?}） */
export class RegisterDto {
  @ApiProperty({ description: '登录名，唯一', example: 'alice' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  username: string;

  @ApiProperty({
    description: '明文密码，bcrypt 哈希后落库',
    example: 'passw0rd',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  @MaxLength(128)
  password: string;

  @ApiProperty({ description: '展示名', example: 'Alice' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  displayName: string;

  @ApiPropertyOptional({
    description: '可选邮箱，唯一',
    example: 'alice@x.com',
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;
}
