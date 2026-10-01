import { Hono } from "hono";
import { serve } from "bun";
import postgres from "postgres";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const app = new Hono();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const BUCKET_NAME = process.env.BUCKET_NAME;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_S3_ENDPOINT_URL = process.env.AWS_S3_ENDPOINT_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

const sql = postgres(DATABASE_URL, {
  ssl: "require",
  max: 5,
});
if (
  !BUCKET_NAME ||
  !AWS_ACCESS_KEY_ID ||
  !AWS_SECRET_ACCESS_KEY ||
  !AWS_S3_ENDPOINT_URL
) {
  throw new Error("Bucket configuration is missing");
}

const s3 = new S3Client({
  region: "us-east-1",
  endpoint: AWS_S3_ENDPOINT_URL,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
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
await sql`
  CREATE TABLE IF NOT EXISTS images (
    id BIGSERIAL PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    content_type TEXT,
    size_bytes BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;
await sql`
  ALTER TABLE images
  ADD COLUMN IF NOT EXISTS sha256 TEXT,
  ADD COLUMN IF NOT EXISTS original_name TEXT,
  ADD COLUMN IF NOT EXISTS object_key TEXT,
 ADD COLUMN IF NOT EXISTS bucket_key TEXT,
  ADD COLUMN IF NOT EXISTS content_type TEXT,
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
`;
await sql`
  CREATE TABLE IF NOT EXISTS batch_images (
    batch_id BIGINT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    image_id BIGINT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (batch_id, image_id)
  )
`;
  await sql`
  CREATE TABLE IF NOT EXISTS records (
    id BIGSERIAL PRIMARY KEY,

    batch_id BIGINT NOT NULL
      REFERENCES batches(id) ON DELETE CASCADE,

    image_id BIGINT NOT NULL
      REFERENCES images(id) ON DELETE CASCADE,

    period_no INTEGER,

    category TEXT NOT NULL,
    subtype TEXT,

    source_name TEXT,
    source_order INTEGER,

    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    item_count INTEGER NOT NULL DEFAULT 0,

    raw_text TEXT,

    record_key TEXT,

    confidence NUMERIC(5,4),

    review_status TEXT NOT NULL DEFAULT 'PENDING',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (batch_id, record_key)
  )
`;
await sql`
  CREATE TABLE IF NOT EXISTS recognition_jobs (
    id BIGSERIAL PRIMARY KEY,

    batch_id BIGINT NOT NULL
      REFERENCES batches(id) ON DELETE CASCADE,

    image_id BIGINT NOT NULL
      REFERENCES images(id) ON DELETE CASCADE,

    status TEXT NOT NULL DEFAULT 'PENDING',

    attempt_count INTEGER NOT NULL DEFAULT 0,

    last_error TEXT,

    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (batch_id, image_id)
  )
`;
  console.log("Database initialized");
}
app.get("/", async (c) => {
  const file = Bun.file("public/index.html");

  if (!(await file.exists())) {
    return c.text("public/index.html not found", 404);
  }

  return new Response(file, {
    headers: {
      "Content-Type": "text/html; charset=utf-8"
    }
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
app.post("/api/images/upload", async (c) => {
  try {
    const form = await c.req.formData();

    const batchId = Number(form.get("batch_id"));
    const files = form
      .getAll("files")
      .filter((item): item is File => item instanceof File);

    if (!batchId) {
      return c.json({
        ok: false,
        error: "batch_id is required"
      }, 400);
    }

    if (files.length === 0) {
      return c.json({
        ok: false,
        error: "No images uploaded"
      }, 400);
    }

    const batch = await sql`
      SELECT id, batch_name
      FROM batches
      WHERE id = ${batchId}
      LIMIT 1
    `;

    if (batch.length === 0) {
      return c.json({
        ok: false,
        error: "Batch not found"
      }, 404);
    }

    const results = [];

    for (const file of files) {
      const buffer = await file.arrayBuffer();

      const hashBuffer = await crypto.subtle.digest(
        "SHA-256",
        buffer
      );

      const sha256 = Array.from(
        new Uint8Array(hashBuffer)
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const existing = await sql`
        SELECT
          id,
          sha256,
          original_name,
          object_key
        FROM images
        WHERE sha256 = ${sha256}
        LIMIT 1
      `;

      let imageId;
      let duplicate = false;

      if (existing.length > 0) {
        imageId = existing[0].id;
        duplicate = true;
      } else {
        const objectKey = `images/${sha256}`;

        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: objectKey,
            Body: new Uint8Array(buffer),
            ContentType:
              file.type || "application/octet-stream",
          })
        );

        const created = await sql`
          INSERT INTO images (
            sha256,
            original_name,
            object_key,
           bucket_key,
            content_type,
            size_bytes
          )
          VALUES (
            ${sha256},
          ${file.name},
            ${objectKey},
            ${objectKey},
            ${file.type || null},
            ${file.size}
          )
          RETURNING id
        `;

        imageId = created[0].id;
      }

      await sql`
        INSERT INTO batch_images (
          batch_id,
          image_id
        )
        VALUES (
          ${batchId},
          ${imageId}
        )
        ON CONFLICT DO NOTHING
      `;
await sql`
  INSERT INTO recognition_jobs (
    batch_id,
    image_id
  )
  VALUES (
    ${batchId},
    ${imageId}
  )
  ON CONFLICT DO NOTHING
`;
      results.push({
        file_name: file.name,
        sha256,
        image_id: imageId,
        duplicate
      });
    }

    return c.json({
      ok: true,
      batch_id: batchId,
      uploaded_count: files.length,
      results
    });

  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
});
app.get("/api/recognition/jobs", async (c) => {
  try {
    const batchId =
      Number(c.req.query("batch_id") || 0);

    const status =
      String(c.req.query("status") || "PENDING")
        .trim()
        .toUpperCase();

    const limit = Math.min(
      Math.max(
        Number(c.req.query("limit") || 50),
        1
      ),
      500
    );

    let jobs;

    if (batchId) {
      jobs = await sql`
        SELECT
          j.id AS job_id,
          j.batch_id,
          j.image_id,
          j.status,
          j.attempt_count,
          j.last_error,
          j.created_at,
          i.original_name,
          i.sha256,
          i.object_key
        FROM recognition_jobs j
        JOIN images i
          ON i.id = j.image_id
        WHERE j.batch_id = ${batchId}
          AND j.status = ${status}
        ORDER BY j.id ASC
        LIMIT ${limit}
      `;
    } else {
      jobs = await sql`
        SELECT
          j.id AS job_id,
          j.batch_id,
          j.image_id,
          j.status,
          j.attempt_count,
          j.last_error,
          j.created_at,
          i.original_name,
          i.sha256,
          i.object_key
        FROM recognition_jobs j
        JOIN images i
          ON i.id = j.image_id
        WHERE j.status = ${status}
        ORDER BY j.id ASC
        LIMIT ${limit}
      `;
    }

    return c.json({
      ok: true,
      status,
      count: jobs.length,
      jobs
    });

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
