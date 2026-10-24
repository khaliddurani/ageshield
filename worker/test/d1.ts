import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';

// D1-compatible test database: SQLite (sql.js/WASM) with every migration applied and foreign keys on, like D1.

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

type Param = string | number | null | undefined;

class TestStatement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
    private readonly params: SqlValue[] = [],
  ) {}

  bind(...params: Param[]): TestStatement {
    return new TestStatement(
      this.db,
      this.sql,
      params.map((p) => p ?? null),
    );
  }

  rows(): Record<string, SqlValue>[] {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(this.params);
      const out: Record<string, SqlValue>[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }

  async run() {
    this.rows();
    return { success: true, results: [], meta: { changes: this.db.getRowsModified() } };
  }

  async all<T>() {
    return { success: true, results: this.rows() as T[], meta: { changes: 0 } };
  }

  async first<T>(): Promise<T | null> {
    return (this.rows()[0] as T | undefined) ?? null;
  }
}

export interface TestD1 {
  db: D1Database;
  raw: Database;
  /** Rows of `sql` (for assertions). */
  query<T = Record<string, SqlValue>>(sql: string, ...params: Param[]): T[];
}

export async function createTestD1(): Promise<TestD1> {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.run('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    raw.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }

  const db = {
    prepare: (sql: string) => new TestStatement(raw, sql),
    async batch(statements: TestStatement[]) {
      raw.run('BEGIN');
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        raw.run('COMMIT');
        return results;
      } catch (err) {
        raw.run('ROLLBACK');
        throw err;
      }
    },
  };

  return {
    db: db as unknown as D1Database,
    raw,
    query: (sql, ...params) => new TestStatement(raw, sql).bind(...params).rows() as never,
  };
}
