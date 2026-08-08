import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProjectsModule } from './projects/projects.module';
import { AgentsModule } from './agents/agents.module';
import { TasksModule } from './tasks/tasks.module';
import { ChatModule } from './chat/chat.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HealthModule } from './health/health.module';
import { WorkersModule } from './workers/workers.module';
import { SkillsModule } from './skills/skills.module';
import { ToolsModule } from './tools/tools.module';
import { McpServersModule } from './mcp-servers/mcp-servers.module';
import { ModelsModule } from './models/models.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // pino JSON 结构化日志（D6）：HTTP 中间件自动注册；NODE_ENV=test 静默，LOG_PRETTY=1 切 pino-pretty
    LoggerModule.forRoot({
      pinoHttp: {
        enabled: process.env.NODE_ENV !== 'test',
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.LOG_PRETTY === '1' && process.env.NODE_ENV !== 'test'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        redact: ['req.headers.authorization', 'req.headers.cookie'],
      },
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ProjectsModule,
    AgentsModule,
    TasksModule,
    ChatModule,
    ArtifactsModule,
    RealtimeModule,
    HealthModule,
    WorkersModule,
    SkillsModule,
    ToolsModule,
    McpServersModule,
    ModelsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
