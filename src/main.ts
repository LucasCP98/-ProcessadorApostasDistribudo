import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { HttpMetricsInterceptor } from './shared/infrastructure/http/metrics.controller.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new ConsoleLogger({ json: true }),
  });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalInterceptors(app.get(HttpMetricsInterceptor));

  if (isNonProductionEnvironment()) {
    const config = new DocumentBuilder()
      .setTitle('Distributed Wager Processor')
      .setDescription(
        'HTTP API for wallet and wager processing, reconciliation and health checks.',
      )
      .setVersion('1.0')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      customSiteTitle: 'Wager Processor API',
    });
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  if (isNonProductionEnvironment()) {
    console.log(`Swagger UI: http://localhost:${port}/docs`);
  }
}
await bootstrap();

function isNonProductionEnvironment(): boolean {
  return process.env.NODE_ENV?.trim().toLowerCase() !== 'production';
}
