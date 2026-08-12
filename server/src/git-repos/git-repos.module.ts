import { forwardRef, Module } from '@nestjs/common';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminGuard } from '../users/admin.guard';
import { WorkersModule } from '../workers/workers.module';
import { GitReposController } from './git-repos.controller';
import { GitReposService } from './git-repos.service';

/**
 * 仓库凭证模块（17 篇《仓库权限与凭证机制》B 方案 server 侧）。
 * - PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 *   （共享同一 id 生成器实例，gc_/gr_ 前缀续号）；
 * - CredentialCryptoService / AdminGuard 本模块内注册（仿 models.module：provider 拥有
 *   者即使用方，models 导出的 CredentialCryptoService 实例仅对 import ModelsModule 的
 *   模块可见，本模块自行注册等价实例——无状态，AES 密钥同源）；
 * - forwardRef(WorkersModule)：保存/吊销后调用 WorkersService.dispatchGitCredentials
 *   按 worker 活跃 agent 过滤下发（WorkersService 依赖 ModelsModule 而非本模块，
 *   forwardRef 仿 models.module.ts 保持与 WorkersModule 的依赖环解耦习惯）。
 */
@Module({
  imports: [RealtimeModule, forwardRef(() => WorkersModule)],
  controllers: [GitReposController],
  providers: [GitReposService, CredentialCryptoService, AdminGuard],
  exports: [GitReposService],
})
export class GitReposModule {}
