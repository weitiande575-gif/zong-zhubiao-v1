// Railway deploy trigger
import { Hono } from "hono";
import { serve } from "bun";
import postgres from "postgres";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const app = new Hono();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const BUCKET_NAME = process.env.BUCKET_NAME;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-6-luna";
const AWS_S3_ENDPOINT_URL = process.env.AWS_S3_ENDPOINT_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}
if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is missing");
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
async function analyzeImageWithOpenAI(
  bytes: Uint8Array,
  contentType: string
) {
  const base64 =
    Buffer.from(bytes).toString("base64");

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Authorization":
          `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
  model: OPENAI_MODEL,

  input: [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text:
`请完整扫描整张图片，从上到下、从左到右，不要只识别局部。

只整理以下12类：
四行、三行、四头、三头、六肖、七肖、八肖、九肖、双波、八尾、七尾、六尾。

规则：
1. 平特、平特一肖全部忽略，不得写入结果。
2. 图片中出现多个期数时，必须按期数分开，绝对不能串期。
3. 同一期如果出现多个独立来源或多组资料，要分别保留，不能合并。
4. 六肖及其他分类不设置固定组数，以图片实际出现多少组为准。
5. “资料正在更新”等没有实际内容的期数，status写updating，records留空。
6. 看不清或无法确定时不要猜，保持原文并降低确定性。
7. source_order按图片从上到下出现顺序，从1开始。
8. items必须保持原图顺序。
9. 反向/剔除类资料统一按补集转换：图片出现“杀、斩杀、排除、除、不要”等表达时，不得把被排除项目直接写入items，必须根据完整全集计算剩余项目后再写入标准分类。
10. 尾数全集为0、1、2、3、4、5、6、7、8、9：杀2尾→八尾；杀3尾→七尾；杀4尾→六尾。例如杀4、9尾，应归类八尾，items为0、1、2、3、5、6、7、8。
11. 头数全集为0头、1头、2头、3头、4头：杀1头→四头；杀2头→三头。例如杀2头，应归类四头，items为0、1、3、4。
12. 行数全集为1行、2行、3行、4行、5行：杀1行→四行；杀2行→三行。必须区分“第几行”与图片中的“第几条资料”。
13. 生肖全集为鼠、牛、虎、兔、龙、蛇、马、羊、猴、鸡、狗、猪：杀3肖→九肖；杀4肖→八肖；杀5肖→七肖；杀6肖→六肖。
14. 波色全集为红波、蓝波、绿波：杀1波→双波。例如杀红波，应归类双波，items为蓝波、绿波。
15. 补集转换后的items必须按照对应全集的标准顺序保存；raw_text必须保存图片原始文字，不得用转换结果覆盖原文。
16. 只有全集、被排除项目和补集结果均能明确确定时才允许转换；看不清、缺项或语义不明确时不得猜测。
17. 平特、平特一肖始终属于范围外，即使出现反向或剔除表达也不得写入有效records。
18. 同一期多个独立来源或多组资料必须分别保存，不得合并；所有分类均以图片实际出现的独立有效资料数量为准，不人为补足固定组数。`
        },
        {
          type: "input_image",
          image_url:
            `data:${contentType};base64,${base64}`,
          detail: "high"
        }
      ]
    }
  ],

  text: {
    format: {
      type: "json_schema",
      name: "zong_zhubiao_image_records",
      strict: true,
      schema: {
        type: "object",
        properties: {
          periods: {
            type: "array",
            items: {
              type: "object",
              properties: {
                period_no: {
                  type: "integer"
                },
                status: {
                  type: "string",
                  enum: [
                    "ok",
                    "updating",
                    "unknown"
                  ]
                },
                records: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      category: {
                        type: "string",
                        enum: [
                          "四行",
                          "三行",
                          "四头",
                          "三头",
                          "六肖",
                          "七肖",
                          "八肖",
                          "九肖",
                          "双波",
                          "八尾",
                          "七尾",
                          "六尾"
                        ]
                      },
                      subtype: {
                        anyOf: [
                          { type: "string" },
                          { type: "null" }
                        ]
                      },
                      source_name: {
                        anyOf: [
                          { type: "string" },
                          { type: "null" }
                        ]
                      },
                      source_order: {
                        type: "integer"
                      },
                      items: {
                        type: "array",
                        items: {
                          type: "string"
                        }
                      },
                      raw_text: {
                        type: "string"
                      }
                    },
                    required: [
                      "category",
                      "subtype",
                      "source_name",
                      "source_order",
                      "items",
                      "raw_text"
                    ],
                    additionalProperties: false
                  }
                }
              },
              required: [
                "period_no",
                "status",
                "records"
              ],
              additionalProperties: false
            }
          }
        },
        required: [
          "periods"
        ],
        additionalProperties: false
      }
    }
  }
})
    }
);    
        
          
            
            
              
                
                









              
              
                
                
                  
                
              
            
          
        
      
    
  

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `OpenAI API ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}
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
  ALTER TABLE batches
  ADD COLUMN IF NOT EXISTS period_mode TEXT NOT NULL DEFAULT 'SINGLE',
  ADD COLUMN IF NOT EXISTS start_period INTEGER,
  ADD COLUMN IF NOT EXISTS end_period INTEGER
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
  period_mode,
  start_period,
  end_period,
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
const periodMode =
  String(body.period_mode || "SINGLE")
    .trim()
    .toUpperCase();

let startPeriod =
  body.start_period === undefined ||
  body.start_period === null ||
  body.start_period === ""
    ? null
    : Number(body.start_period);

let endPeriod =
  body.end_period === undefined ||
  body.end_period === null ||
  body.end_period === ""
    ? null
    : Number(body.end_period);

if (!["SINGLE", "RANGE"].includes(periodMode)) {
  return c.json({
    ok: false,
    error: "period_mode must be SINGLE or RANGE"
  }, 400);
}

if (
  startPeriod !== null &&
  !Number.isInteger(startPeriod)
) {
  return c.json({
    ok: false,
    error: "start_period must be an integer"
  }, 400);
}

if (
  endPeriod !== null &&
  !Number.isInteger(endPeriod)
) {
  return c.json({
    ok: false,
    error: "end_period must be an integer"
  }, 400);
}

if (periodMode === "SINGLE" && startPeriod !== null) {
  endPeriod = startPeriod;
}

if (
  periodMode === "RANGE" &&
  (
    startPeriod === null ||
    endPeriod === null ||
    startPeriod > endPeriod
  )
) {
  return c.json({
    ok: false,
    error: "RANGE requires valid start_period and end_period"
  }, 400);
}
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
  period_mode,
  start_period,
  end_period,
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
  INSERT INTO batches (
    batch_name,
    period_mode,
    start_period,
    end_period
  )
  VALUES (
    ${batchName},
    ${periodMode},
    ${startPeriod},
    ${endPeriod}
  )
  RETURNING
    id,
    batch_name,
    period_mode,
    start_period,
    end_period,
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
app.post("/api/recognition/claim", async (c) => {
  try {
    let body: any = {};

    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const batchId =
      Number(body.batch_id || 0);

    let claimed;

    if (batchId) {
      claimed = await sql`
        WITH next_job AS (
          SELECT id
          FROM recognition_jobs
          WHERE status = 'PENDING'
            AND batch_id = ${batchId}
          ORDER BY id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE recognition_jobs j
        SET
          status = 'PROCESSING',
          attempt_count = j.attempt_count + 1,
          started_at = NOW(),
          last_error = NULL
        FROM next_job
        WHERE j.id = next_job.id
        RETURNING
          j.id AS job_id,
          j.batch_id,
          j.image_id,
          j.status,
          j.attempt_count
      `;
    } else {
      claimed = await sql`
        WITH next_job AS (
          SELECT id
          FROM recognition_jobs
          WHERE status = 'PENDING'
          ORDER BY id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE recognition_jobs j
        SET
          status = 'PROCESSING',
          attempt_count = j.attempt_count + 1,
          started_at = NOW(),
          last_error = NULL
        FROM next_job
        WHERE j.id = next_job.id
        RETURNING
          j.id AS job_id,
          j.batch_id,
          j.image_id,
          j.status,
          j.attempt_count
      `;
    }

    if (claimed.length === 0) {
      return c.json({
        ok: true,
        job: null,
        message: "No pending jobs"
      });
    }

    const job = await sql`
      SELECT
        j.id AS job_id,
        j.batch_id,
        j.image_id,
        j.status,
        j.attempt_count,
        i.original_name,
        i.sha256,
        i.object_key
      FROM recognition_jobs j
      JOIN images i
        ON i.id = j.image_id
      WHERE j.id = ${claimed[0].job_id}
      LIMIT 1
    `;

    return c.json({
      ok: true,
      job: job[0]
    });

  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
});
app.get("/api/recognition/image", async (c) => {
  try {
    const jobId =
      Number(c.req.query("job_id") || 0);

    if (!jobId) {
      return c.json({
        ok: false,
        error: "job_id is required"
      }, 400);
    }

    const rows = await sql`
      SELECT
        j.id AS job_id,
        j.image_id,
        i.original_name,
        i.object_key,
        i.content_type
      FROM recognition_jobs j
      JOIN images i
        ON i.id = j.image_id
      WHERE j.id = ${jobId}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return c.json({
        ok: false,
        error: "Job not found"
      }, 404);
    }

    const image = rows[0];

    const object = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: image.object_key
      })
    );

    if (!object.Body) {
      return c.json({
        ok: false,
        error: "Image body is empty"
      }, 404);
    }

    const bytes =
      await object.Body.transformToByteArray();

    return new Response(bytes, {
      headers: {
        "Content-Type":
          object.ContentType ||
          image.content_type ||
          "application/octet-stream",

        "Content-Disposition":
          `inline; filename="${image.original_name}"`,

        "Cache-Control": "no-store"
      }
    });

  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
});
app.get("/api/recognition/analyze", async (c) => {
  try {
    const jobId =
      Number(c.req.query("job_id") || 0);

    if (!jobId) {
      return c.json({
        ok: false,
        error: "job_id is required"
      }, 400);
    }

    const rows = await sql`
      SELECT
        j.id AS job_id,
        j.image_id,
        j.batch_id,
        i.original_name,
        i.object_key,
        i.content_type
      FROM recognition_jobs j
      JOIN images i
        ON i.id = j.image_id
      WHERE j.id = ${jobId}
      LIMIT 1
    `;

    if (rows.length === 0) {
      return c.json({
        ok: false,
        error: "Job not found"
      }, 404);
    }

    const image = rows[0];

    const object = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: image.object_key
      })
    );

    if (!object.Body) {
      return c.json({
        ok: false,
        error: "Image body is empty"
      }, 404);
    }

    const bytes =
      await object.Body.transformToByteArray();

    const contentType =
      object.ContentType ||
      image.content_type ||
      "image/jpeg";

    const analysis =
      await analyzeImageWithOpenAI(
        bytes,
        contentType
      );

    const text =
      (analysis.output || [])
        .flatMap((item: any) =>
          Array.isArray(item.content)
            ? item.content
            : []
        )
        .filter((part: any) =>
          part.type === "output_text"
        )
        .map((part: any) =>
          String(part.text || "")
        )
        .join("\n")
        .trim();

        const parsed = JSON.parse(text);

    if (!parsed || !Array.isArray(parsed.periods)) {
      throw new Error("Invalid AI response: periods is missing");
    }

    let insertedCount = 0;

    for (const period of parsed.periods) {
      const periodNo = Number(period.period_no);

      if (!Number.isInteger(periodNo)) {
        continue;
      }

      const records = Array.isArray(period.records)
        ? period.records
        : [];

      for (const record of records) {
        const category = String(record.category || "").trim();

        if (
          !category ||
          category === "平特" ||
          category === "平特一肖"
        ) {
          continue;
        }

        const subtype =
          record.subtype == null
            ? null
            : String(record.subtype).trim();

        const sourceName =
          record.source_name == null
            ? null
            : String(record.source_name).trim();

        const sourceOrder = Number(record.source_order || 0);

        const items = Array.isArray(record.items)
          ? record.items.map((item: any) => String(item))
          : [];

        const rawText = String(record.raw_text || "");

        const recordKey = [
          image.image_id,
          periodNo,
          category,
          subtype || "",
          sourceName || "",
          sourceOrder,
          JSON.stringify(items)
        ].join("|");

        const inserted = await sql`
          INSERT INTO records (
            batch_id,
            image_id,
            period_no,
            category,
            subtype,
            source_name,
            source_order,
            items,
            item_count,
            raw_text,
            record_key,
            confidence,
            review_status
          )
          VALUES (
            ${rows[0].batch_id},
            ${image.image_id},
            ${periodNo},
            ${category},
            ${subtype},
            ${sourceName},
            ${sourceOrder},
            ${JSON.stringify(items)}::jsonb,
            ${items.length},
            ${rawText},
            ${recordKey},
            ${null},
            'PENDING'
          )
          ON CONFLICT (batch_id, record_key)
          DO NOTHING
          RETURNING id
        `;

        insertedCount += inserted.length;
      }
    }

    await sql`
      UPDATE recognition_jobs
      SET
        status = 'DONE',
        finished_at = NOW(),
        last_error = NULL
      WHERE id = ${jobId}
    `;

    return c.json({
      ok: true,
      job_id: jobId,
      image_id: image.image_id,
      original_name: image.original_name,
      model: OPENAI_MODEL,
      response_id: analysis.id || null,
      inserted_count: insertedCount,
      periods_count: parsed.periods.length,
      result: parsed
    });

 
  } catch (error) {
    console.error("Recognition analyze failed:", error);
    const failedJobId =
      Number(c.req.query("job_id") || 0);

    if (failedJobId) {
      try {
        await sql`
          UPDATE recognition_jobs
          SET
            status = 'FAILED',
            finished_at = NOW(),
            last_error = ${String(error)}
          WHERE id = ${failedJobId}
        `;
      } catch {
        // 保留原始错误
      }
    }

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
