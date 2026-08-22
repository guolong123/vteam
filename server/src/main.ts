import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import * as express from 'express';
import { AppModule } from './app.module';
import {
  setSwaggerRawDocument,
  SwaggerDocsProvider,
} from './swagger-mcp/swagger-docs.provider';
import { resolveUploadDir } from './uploads/uploads.constants';

async function bootstrap() {
  // bufferLogs：缓冲 Nest 启动期框架日志，useLogger 后 flush 输出为 pino JSON
  // bodyParser: false → 禁用 Nest 默认 100kb 限制，改由下方 express.json({limit:'5mb'}) 接管
  // （Worker 全量 provider 上报可达 5mb，未配置也展示场景）
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  } as never);

  // 全局路由前缀 /api/v1（对齐 09 篇 API 契约）
  app.setGlobalPrefix('api/v1');

  // 静态文件服务：/uploads/* → server uploads 目录（上传端点磁盘存储目录，读/写同源）。
  // 文件经 UPLOAD_DIR 可覆盖（默认 server/uploads，upload.constants resolveUploadDir 同源）；
  // 目录不存在时静态挂载不报错，首次上传由 multer destination 递归创建。
  app.useStaticAssets(resolveUploadDir(), { prefix: '/uploads/' });

  // Worker 上报：capabilities.models 全量 provider 展开后可达 1-2k 条（未配置也展示），
  // 默认 express json 100kb 会 PayloadTooLarge（v1-driver 全量上报）。放宽至 5mb。
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ limit: '5mb', extended: true }));

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

  // Swagger-MCP（vteam-api）数据源：createDocument 结果写入模块级 store 并做一次
  // $ref dereference 缓存（v11 clone 输入，不污染 Swagger UI 文档；失败 warn 降级
  // 原始文档，不阻断启动），供 generateSwaggerTools 生成 MCP 工具
  setSwaggerRawDocument(document);
  await new SwaggerDocsProvider().initialize();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  Logger.log(
    `🚀 Server running on http://localhost:${port}/api/v1`,
    'Bootstrap',
  );
}
bootstrap();
