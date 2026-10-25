import { Injectable, Logger, OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { RuntimeConfig } from "../config/runtime-config";
import type { AuthIdentity } from "../auth/auth.types";

/**
 * Two pools:
 * - `pool` (DATABASE_URL_RUNTIME, least-privilege role): all tenant work. Postgres RLS is enforced on it, so a query that
 *   forgets `organization_id` still cannot see another brand.
 * - `systemPool` (DATABASE_URL, table owner): only the deliberate cross-tenant paths — `systemQuery` and
 *   `platformTransaction` (identity resolution, platform administration, device authentication). Keep these rare and reviewed.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;
  private readonly systemPool: Pool;
  constructor(private readonly config: RuntimeConfig) {
    this.systemPool = new Pool({ connectionString: config.databaseUrl, max: 6, statement_timeout: 10_000 });
    this.pool = config.runtimeDatabaseUrl
      ? new Pool({ connectionString: config.runtimeDatabaseUrl, max: 10, statement_timeout: 10_000 })
      : this.systemPool;
  }

  /** Refuse to run in production if the tenant pool could bypass row-level security. */
  async onModuleInit() {
    const check = (await this.pool.query(
      `SELECT r.rolsuper OR r.rolbypassrls AS bypass,
              (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid AND c.relkind='r' AND c.relnamespace='public'::regnamespace) AS owned
         FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
    if (check?.bypass || check?.owned > 0) {
      const message = `Tenant database role bypasses RLS (superuser/BYPASSRLS or owns ${check.owned} tables). Set DATABASE_URL_RUNTIME to a least-privilege role.`;
      if (this.config.nodeEnv === "production") throw new Error(message);
      this.logger.warn(message);
    } else this.logger.log("Tenant queries run on a least-privilege role; row-level security is enforced by Postgres.");
  }
  async tenantTransaction<T>(identity: AuthIdentity, work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.organization_id',$1,true)", [identity.organizationId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  /** A plain transaction for cross-tenant platform work (provisioning); tenant-scoped code must use tenantTransaction. */
  async platformTransaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.systemPool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  /** Tenant-safe ad-hoc query on the least-privilege pool (RLS applies; no organization is set, so tenant tables return nothing). */
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<Row>(text, values);
  }

  /** Deliberately cross-tenant query on the owner pool. Every call site must filter explicitly and be justified in review. */
  systemQuery<Row extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.systemPool.query<Row>(text, values);
  }
  async onModuleDestroy() {
    if (this.pool !== this.systemPool) await this.pool.end();
    await this.systemPool.end();
  }
}
