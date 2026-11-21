import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

@Injectable()
export class PostgresStateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresStateService.name);
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => {
      void this.deleteExpired().catch((error: unknown) => {
        this.logger.error('Failed to remove expired state rows', error instanceof Error ? error.stack : String(error));
      });
    }, 60_000);
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const rows = (await this.dataSource.query(
      `SELECT value FROM app_state WHERE state_key = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [key],
    )) as Array<{ value: T }>;
    return rows[0]?.value ?? null;
  }

  async setJson(key: string, value: unknown, ttlSeconds: number, ownerKey: string | null = null): Promise<void> {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('State value must be JSON serializable.');
    await this.dataSource.query(
      `INSERT INTO app_state (state_key, value, expires_at, owner_key)
       VALUES ($1, $2::jsonb, now() + ($3::double precision * interval '1 second'), $4)
       ON CONFLICT (state_key) DO UPDATE
         SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, owner_key = EXCLUDED.owner_key`,
      [key, json, ttlSeconds, ownerKey],
    );
  }

  async touch(key: string, ttlSeconds: number): Promise<boolean> {
    const rows = await this.dataSource.query(
      `UPDATE app_state
          SET expires_at = now() + ($2::double precision * interval '1 second')
        WHERE state_key = $1 AND (expires_at IS NULL OR expires_at > now())
        RETURNING state_key`,
      [key, ttlSeconds],
    );
    return rows.length > 0;
  }

  async delete(key: string): Promise<void> {
    await this.dataSource.query(`DELETE FROM app_state WHERE state_key = $1`, [key]);
  }

  async deleteOwner(ownerKey: string, exceptKey?: string): Promise<void> {
    if (exceptKey) {
      await this.dataSource.query(`DELETE FROM app_state WHERE owner_key = $1 AND state_key <> $2`, [ownerKey, exceptKey]);
      return;
    }
    await this.dataSource.query(`DELETE FROM app_state WHERE owner_key = $1`, [ownerKey]);
  }

  async cached<T>(scope: string, key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const versionRows = (await this.dataSource.query(`SELECT value->>'version' AS version FROM app_state WHERE state_key = $1`, [
      `cache:ver:${scope}`,
    ])) as Array<{ version: string | null }>;
    const version = Number(versionRows[0]?.version ?? 0);
    const fullKey = `cache:${scope}:${version}:${key}`;
    const hit = await this.getJson<T>(fullKey);
    if (hit !== null) return hit;
    const value = await loader();
    await this.setJson(fullKey, value, ttlSeconds);
    return value;
  }

  async invalidate(scope: string): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO app_state (state_key, value)
       VALUES ($1, '{"version": 1}'::jsonb)
       ON CONFLICT (state_key) DO UPDATE
         SET value = jsonb_build_object('version', COALESCE((app_state.value->>'version')::bigint, 0) + 1),
             expires_at = NULL`,
      [`cache:ver:${scope}`],
    );
  }

  async incrementWindow(key: string, windowSeconds: number): Promise<{ count: number; ttl: number }> {
    const rows = (await this.dataSource.query(
      `INSERT INTO app_state (state_key, value, expires_at)
       VALUES ($1, jsonb_build_object('count', 1), now() + ($2::double precision * interval '1 second'))
       ON CONFLICT (state_key) DO UPDATE SET
         value = CASE
           WHEN app_state.expires_at IS NULL OR app_state.expires_at <= now()
             THEN jsonb_build_object('count', 1)
           ELSE jsonb_set(app_state.value, '{count}', to_jsonb((app_state.value->>'count')::integer + 1), true)
         END,
         expires_at = CASE
           WHEN app_state.expires_at IS NULL OR app_state.expires_at <= now()
             THEN now() + ($2::double precision * interval '1 second')
           ELSE app_state.expires_at
         END
       RETURNING (value->>'count')::integer AS count,
                 GREATEST(CEIL(EXTRACT(EPOCH FROM (expires_at - now()))), 0)::integer AS ttl`,
      [key, windowSeconds],
    )) as Array<{ count: number; ttl: number }>;
    return { count: Number(rows[0]!.count), ttl: Math.max(Number(rows[0]!.ttl), 0) };
  }

  async windowState(key: string): Promise<{ count: number; ttl: number }> {
    const rows = (await this.dataSource.query(
      `SELECT (value->>'count')::integer AS count,
              GREATEST(CEIL(EXTRACT(EPOCH FROM (expires_at - now()))), 0)::integer AS ttl
         FROM app_state WHERE state_key = $1 AND expires_at > now()`,
      [key],
    )) as Array<{ count: number; ttl: number }>;
    return rows[0] ? { count: Number(rows[0].count), ttl: Number(rows[0].ttl) } : { count: 0, ttl: 0 };
  }

  async incrementRateLimit(
    key: string,
    ttlMs: number,
    limit: number,
    blockDurationMs: number,
  ): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }> {
    const rows = (await this.dataSource.query(
      `INSERT INTO app_state (state_key, value, expires_at)
       VALUES (
         $1,
         jsonb_build_object('hits', 1, 'blocked_until', NULL),
         now() + ($2::double precision * interval '1 millisecond')
       )
       ON CONFLICT (state_key) DO UPDATE SET
         value = CASE
           WHEN app_state.expires_at IS NULL OR app_state.expires_at <= now()
             THEN jsonb_build_object('hits', 1, 'blocked_until', NULL)
           WHEN COALESCE((app_state.value->>'blocked_until')::timestamptz > now(), false)
             THEN app_state.value
           WHEN COALESCE((app_state.value->>'hits')::integer, 0) + 1 > $3 AND $4 > 0
             THEN jsonb_build_object(
               'hits', COALESCE((app_state.value->>'hits')::integer, 0) + 1,
               'blocked_until', to_jsonb(now() + ($4::double precision * interval '1 millisecond'))
             )
           ELSE jsonb_build_object(
             'hits', COALESCE((app_state.value->>'hits')::integer, 0) + 1,
             'blocked_until', NULL
           )
         END,
         expires_at = CASE
           WHEN app_state.expires_at IS NULL OR app_state.expires_at <= now()
             THEN now() + ($2::double precision * interval '1 millisecond')
           ELSE app_state.expires_at
         END
       RETURNING (value->>'hits')::integer AS total_hits,
                 GREATEST(CEIL(EXTRACT(EPOCH FROM (expires_at - now()))), 0)::integer AS time_to_expire,
                 COALESCE((value->>'blocked_until')::timestamptz > now(), false) AS is_blocked,
                 CASE
                   WHEN COALESCE((value->>'blocked_until')::timestamptz > now(), false)
                     THEN GREATEST(CEIL(EXTRACT(EPOCH FROM ((value->>'blocked_until')::timestamptz - now()))), 0)::integer
                   ELSE 0
                 END AS time_to_block_expire`,
      [key, ttlMs, limit, blockDurationMs],
    )) as Array<{ total_hits: number; time_to_expire: number; is_blocked: boolean; time_to_block_expire: number }>;
    const row = rows[0]!;
    return {
      totalHits: Number(row.total_hits),
      timeToExpire: Number(row.time_to_expire),
      isBlocked: row.is_blocked,
      timeToBlockExpire: Number(row.time_to_block_expire),
    };
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const token = randomUUID();
    const rows = await this.dataSource.query(
      `INSERT INTO app_state (state_key, value, expires_at)
       VALUES ($1, jsonb_build_object('token', $2::text), now() + ($3::double precision * interval '1 second'))
       ON CONFLICT (state_key) DO UPDATE
         SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
         WHERE app_state.expires_at IS NULL OR app_state.expires_at <= now()
       RETURNING state_key`,
      [key, token, ttlSeconds],
    );
    return rows.length ? token : null;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.dataSource.query(`DELETE FROM app_state WHERE state_key = $1 AND value->>'token' = $2`, [key, token]);
  }

  async deleteExpired(): Promise<void> {
    await this.dataSource.query(`DELETE FROM app_state WHERE expires_at <= now()`);
  }
}
