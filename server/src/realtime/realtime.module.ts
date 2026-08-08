import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { IdGeneratorService } from '../common/id-generator';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';

/**
 * RealtimeModule —— 统一 SSE 事件基座（09 篇 §4）。
 *
 * - RealtimeService：事件总线（EventEmitter）+ realtime_events 持久化，emit/broadcast 供其他模块注入
 * - RealtimeController：GET /api/v1/events（SSE，query token 鉴权，scope 过滤 + since 续拉 + 心跳保活）
 *
 * 导出 RealtimeService，供 Chat/Tasks/Artifacts 等模块注入以广播业务事件（Phase 2）。
 */
@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? 'dev-secret',
        signOptions: {
          expiresIn: (config.get<string>('JWT_ACCESS_EXPIRES_IN') ??
            '2h') as any,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [RealtimeController],
  providers: [RealtimeService, IdGeneratorService],
  exports: [RealtimeService, IdGeneratorService],
})
export class RealtimeModule {}
