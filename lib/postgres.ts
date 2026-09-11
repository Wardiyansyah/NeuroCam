import { Pool } from "pg";

const globalState = globalThis as unknown as {
  __sipijarPostgresPool?: Pool;
};

export function getPostgresPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;

  return (globalState.__sipijarPostgresPool ??= new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  }));
}
