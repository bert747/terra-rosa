import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// A single lazily-created connection pool, reused across requests.
// `max` is intentionally small — this app has 1-3 concurrent users.
declare global {
  // eslint-disable-next-line no-var
  var __terraRosaSql: ReturnType<typeof postgres> | undefined;
}

function getConnection() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill in real values."
    );
  }
  if (!global.__terraRosaSql) {
    global.__terraRosaSql = postgres(url, { max: 5 });
  }
  return global.__terraRosaSql;
}

// db is created lazily via a Proxy so that `next build` (which imports this
// module at build time for route type-checking) never needs a live DATABASE_URL.
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

function getDb() {
  if (!_db) {
    _db = drizzle(getConnection(), { schema });
  }
  return _db;
}

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});
