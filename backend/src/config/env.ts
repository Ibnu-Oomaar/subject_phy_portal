import { z } from 'zod';

const boolish = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  DB_LOGGING: boolish.default(false),
  APP_ORIGIN: z
    .string()
    .min(1)
    .transform((v) => v.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean))
    .refine((list) => list.length > 0 && list.every((o) => URL.canParse(o)), 'must be one or more comma-separated URLs'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  SESSION_COOKIE_NAME: z.string().min(1).default('mp_sid'),
  COOKIE_SECURE: boolish.optional(),
  TEACHER_SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(480),
  STUDENT_SESSION_IDLE_MINUTES: z.coerce.number().int().positive().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().positive().default(12),
  STUDENT_ID_PATTERN: z.string().min(1).default('^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  const v = parsed.data;
  const isTest = v.NODE_ENV === 'test';
  const effectiveDatabaseUrl = isTest ? (v.TEST_DATABASE_URL ?? v.DATABASE_URL) : v.DATABASE_URL;
  return {
    ...v,
    DATABASE_URL: effectiveDatabaseUrl,
    isProduction: v.NODE_ENV === 'production',
    isTest: v.NODE_ENV === 'test',
    cookieSecure: v.COOKIE_SECURE ?? v.NODE_ENV === 'production',
    appOrigins: v.APP_ORIGIN,
    studentIdRegex: new RegExp(v.STUDENT_ID_PATTERN),
  };
}

export const env = load();
export type Env = typeof env;
