import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableCors({
    // Allow any origin. We reflect the request origin (`origin: true`) rather
    // than '*' because credentials (the httpOnly session cookie) are enabled,
    // and the CORS spec forbids '*' together with Access-Control-Allow-Credentials.
    origin: true,
    credentials: true,
  });

  // ── OpenAPI / Swagger ──
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Ticketer API')
    .setDescription(
      'Backend for the Ticketer university exam tickets platform. ' +
        'Teachers authenticate via JWT; students authenticate via per-session ' +
        'opaque tokens (sent as the `ticketer_session` httpOnly cookie or the ' +
        '`x-session-token` header). Realtime events are emitted on the Socket.IO ' +
        '`/sessions` namespace.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'jwt',
    )
    .addCookieAuth('ticketer_session', { type: 'apiKey' }, 'session')
    .addTag('auth', 'Login + current-user lookup')
    .addTag('subjects', 'Teacher subjects (scoped to JWT)')
    .addTag('tickets', 'Exam ticket builder + directory (scoped to JWT)')
    .addTag('sessions', 'Live exam session lifecycle (teacher + student + proctor)')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = config.get<number>('port') ?? 3000;
  await app.listen(port);
  console.log(`🎟  Ticketer API listening on http://localhost:${port}`);
  console.log(`📘  Swagger UI at        http://localhost:${port}/docs`);
}

bootstrap();
