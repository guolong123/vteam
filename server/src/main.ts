import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  // bufferLogs：缓冲 Nest 启动期框架日志，useLogger 后 flush 输出为 pino JSON
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // 全局路由前缀 /api/v1（对齐 09 篇 API 契约）
  app.setGlobalPrefix('api/v1');

  // 全局 DTO 校验（class-validator，对齐 09 篇 §2.1 的 VALIDATION_* 语义）
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // pino JSON 结构化日志：HTTP 访问日志由 nestjs-pino LoggerModule 自动注册中间件，
  // 此处将全局 Nest Logger 接管为 pino，业务日志统一输出 JSON 行
  app.useLogger(app.get(PinoLogger));
  app.flushLogs();

  // OpenAPI (Swagger) 文档，挂载于 /api/v1/docs
  const config = new DocumentBuilder()
    .setTitle('AI Agents Platform API')
    .setDescription('AI 智能体平台控制面 API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  Logger.log(
    `🚀 Server running on http://localhost:${port}/api/v1`,
    'Bootstrap',
  );
}
bootstrap();
