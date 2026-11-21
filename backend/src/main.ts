import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // configureApp installs the JSON parser with an explicit size limit
    logger: env.isProduction ? ['error', 'warn', 'log'] : ['error', 'warn', 'log', 'debug'],
  });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`Physics portal API listening on :${env.PORT} (${env.NODE_ENV})`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
