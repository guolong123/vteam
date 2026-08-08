import { forwardRef, Module } from '@nestjs/common';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminGuard } from '../users/admin.guard';
import { WorkersModule } from '../workers/workers.module';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

/**
 * 模型目录模块（C4 凭据端点 + C3 目录 CRUD + C5 凭据下发触发）。
 * PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 * （共享同一 id 生成器实例）；AdminGuard 在本模块内注册（依赖全局 PrismaService）。
 * CredentialCryptoService 加密 provider token（AES-256-GCM，17 篇 §3.4）；
 * 导出 ModelsService 与 CredentialCryptoService 供 C5（凭据下发）注入读取解密。
 * forwardRef(WorkersModule)：C5 凭据保存后调用 WorkersService.dispatchModelCredentials
 * 触发下发（WorkersService 亦依赖本模块导出的 CredentialCryptoService 做注册回放，双向循环）。
 */
@Module({
  imports: [RealtimeModule, forwardRef(() => WorkersModule)],
  controllers: [ModelsController],
  providers: [ModelsService, CredentialCryptoService, AdminGuard],
  exports: [ModelsService, CredentialCryptoService],
})
export class ModelsModule {}
