
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { env } from './config/env';
import { originCheck, securityHeaders } from './security/http-security.middleware';

/** Shared by main.ts and the integration tests so both run the exact same HTTP pipeline. */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.disable('x-powered-by');
  // Number of reverse proxies in front of the API; needed so req.ip (rate limiting) is the real client address.
  express.set('trust proxy', env.TRUST_PROXY);
  express.setGlobalPrefix('api');

  app.enableCors({
    origin: env.appOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });

  express.use(securityHeaders);
  express.use(cookieParser());
  express.use(json({ limit: '1mb' }));
  express.use(originCheck);
  express.useGlobalFilters(new AllExceptionsFilter());
}
