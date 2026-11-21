
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Conservative response headers for a JSON API. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  if (env.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/**
 * Defence in depth against CSRF next to SameSite cookies and the CSRF token: a browser always sends Origin on
 * cross-site state-changing requests, so a request from any origin other than the app's is rejected.
 * Requests without an Origin header (curl, Postman, server-to-server) still need the session + CSRF token.
 */
export function originCheck(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !env.appOrigins.includes(origin)) {
    res.status(403).json({
      error: { code: 'CSRF_INVALID', message: 'The request origin is not allowed.' },
    });
    return;
  }
  next();
}
