import { forwardRef, Module } from '@nestjs/common';
import { CredentialCryptoService } from '../common/credential-crypto.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { AdminGuard } from '../users/admin.guard';
import { WorkersModule } from '../workers/workers.module';
import { GitCredentialsController } from './git-credentials.controller';
import { GitCredentialsService } from './git-credentials.service';
import { GitReposController } from './git-repos.controller';
import { GitReposService } from './git-repos.service';

/**
 * 仓库凭证模块（凭证池分离后：凭证池独立 + 仓库引用凭证）。
 * - PrismaService 由全局 PrismaModule 提供；IdGeneratorService 由 RealtimeModule 导出
 *   （共享同一 id 生成器实例，gc_/gro_/gr_ 前缀续号）；
 * - CredentialCryptoService / AdminGuard 本模块内注册；
 * - forwardRef(WorkersModule)：仓库保存/吊销后调用 WorkersService.dispatchGitCredentials
 *   按 worker 活跃 agent 过滤下发。
 */
@Module({
  imports: [RealtimeModule, forwardRef(() => WorkersModule)],
  controllers: [GitCredentialsController, GitReposController],
  providers: [GitCredentialsService, GitReposService, CredentialCryptoService, AdminGuard],
  exports: [GitCredentialsService, GitReposService],
})
export class GitReposModule {}
