import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JWT_TOKEN_TYPE } from './auth.constants';
import { JwtPayload } from './interfaces/jwt-payload.interface';

/**
 * passport-jwt 策略：从 Authorization: Bearer <accessToken> 提取并校验 access JWT。
 * 仅接受 type=access 的 token；type=refresh 一律拒绝（防 refresh token 当 access 用）。
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') ?? 'dev-secret',
    });
  }

  validate(payload: JwtPayload) {
    if (payload.type !== JWT_TOKEN_TYPE.ACCESS) {
      return null; // 拒绝 refresh token
    }
    return {
      id: payload.sub,
      username: payload.username,
      roleId: payload.roleId,
      tokenType: payload.type,
    };
  }
}
