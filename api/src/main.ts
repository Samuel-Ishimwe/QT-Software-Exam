import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Cadastral Parcel Service API')
    .setDescription(
      'NestJS/PostGIS proof-of-concept for a national land administration parcel service. ' +
        'Covers the officer- and citizen-facing parcel query endpoints, the subdivision rule ' +
        'engine (Task 3), data quality reporting (Task 4), tolerance configuration, the ' +
        'concurrent-editing-conflict boundary-edit endpoint (bonus (c)), and the OGC API - ' +
        'Features surface over the public parcel layer (bonus (a)). See README.md for curl ' +
        'walkthroughs and ARCHITECTURE.md for design rationale.',
    )
    .setVersion('1.0')
    .addTag('parcels', 'Officer- and citizen-facing parcel queries (bbox viewport, UPI lookup, lineage)')
    .addTag('subdivision', 'Task 3 — the subdivision rule engine')
    .addTag('boundary-edit', 'Bonus (c) — single-parcel geometry corrections with concurrency-conflict detection')
    .addTag('qa', 'Task 4 — data quality report')
    .addTag('config', 'System tolerance configuration (GET /admin/config)')
    .addTag('ogc', 'Bonus (a) — OGC API - Features over the public parcel layer')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`parcel-api listening on :${port}`);
  console.log(`Swagger UI at http://localhost:${port}/docs`);
}

bootstrap();
