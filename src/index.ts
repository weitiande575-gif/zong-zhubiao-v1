import { Hono } from "hono";
import { serve } from "bun";
import postgres from "postgres";

const app = new Hono();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

const sql = postgres(DATABASE_URL, {
  ssl: "require",
  max: 5,
});

async function initDatabase() {
  await sql`
    CREATE TABLE IF NOT EXISTS batches (
      id BIGSERIAL PRIMARY KEY,
      batch_name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  console.log("Database initialized");
}

app.get("/", (c) => {
  return c.json({
    ok: true,
    service: "总主表 Master API V1",
    message: "API is running"
  });
});

app.get("/health", async (c) => {
  try {
    const result = await sql`
      SELECT NOW() AS now
    `;

    return c.json({
      ok: true,
      service: "master-api-v1",
      database: "connected",
      time: result[0]?.now
    });
  } catch (error) {
    return c.json({
      ok: false,
      database: "error",
      error: String(error)
    }, 500);
  }
});

app.get("/api/batches", async (c) => {
  try {
    const batches = await sql`
      SELECT
        id,
        batch_name,
        status,
        created_at
      FROM batches
      ORDER BY id DESC
    `;

    return c.json({
      ok: true,
      batches
    });
  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
});

app.post("/api/batches", async (c) => {
  try {
    const body = await c.req.json();
    const batchName =
      String(body.batch_name || "").trim();

    if (!batchName) {
      return c.json({
        ok: false,
        error: "batch_name is required"
      }, 400);
    }

    const existing = await sql`
      SELECT
        id,
        batch_name,
        status,
        created_at
      FROM batches
      WHERE batch_name = ${batchName}
      LIMIT 1
    `;

    if (existing.length > 0) {
      return c.json({
        ok: true,
        duplicate: true,
        batch: existing[0]
      });
    }

    const created = await sql`
      INSERT INTO batches (batch_name)
      VALUES (${batchName})
      RETURNING
        id,
        batch_name,
        status,
        created_at
    `;

    return c.json({
      ok: true,
      duplicate: false,
      batch: created[0]
    }, 201);

  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
});

app.get("/api/dashboard", async (c) => {
  try {
    const result = await sql`
      SELECT COUNT(*)::int AS count
      FROM batches
    `;

    return c.json({
      ok: true,
      batch_count: result[0]?.count || 0,
      rules: {
        liuxiao: "不设固定闭合组数",
        excluded: [
          "平特",
          "平特一肖"
        ]
      }
    });
  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
});

await initDatabase();

serve({
  fetch: app.fetch,
  port: PORT,
  hostname: "0.0.0.0"
});

console.log(
  `Master API V1 running on port ${PORT}`
);
