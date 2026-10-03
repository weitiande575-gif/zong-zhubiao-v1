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

只整理以下15类：
五行、四行、三行、五头、四头、三头、六肖、七肖、八肖、九肖、双波、波色、八尾、七尾、六尾。


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
18. 同一期多个独立来源或多组资料必须分别保存，不得合并；所有分类均以图片实际出现的独立有效资料数量为准，不人为补足固定组数。
19. 五行分类：图片明确出现“五行”资料时，category写“五行”，items按原图顺序保存；不得与“四行、三行”混淆。同一期出现多组五行资料时，每组作为独立record保存。
20. 五头分类：图片明确出现“五头”或完整5个头数资料时，category写“五头”，items按原图顺序保存；头数统一规范为0、1、2、3、4，不得与“四头、三头”混淆。同一期出现多组五头资料时，每组作为独立record保存。
21. 波色分类：图片明确出现“波色”资料且内容属于红波、蓝波、绿波时，category写“波色”，items按原图顺序保存；“双波”仍单独归类为“双波”，不得把波色与双波合并。同一期多个独立来源分别保存。`
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
  "五行",
  "四行",
  "三行",
  "五头",
  "四头",
  "三头",
  "六肖",
  "七肖",
  "八肖",
  "九肖",
  "双波",
  "波色",
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
function validateRecognitionRecord(row: any) {
  const category = String(row.category || "");
  const rawText = String(row.raw_text || "");

  let parsedItems: any = row.items;

  if (typeof parsedItems === "string") {
    try {
      parsedItems = JSON.parse(parsedItems);
    } catch {
      parsedItems = [];
    }
  }

  const actual = Array.isArray(parsedItems)
    ? parsedItems.map(String)
    : [];

if (
  category === "八尾" ||
  category === "七尾" ||
  category === "六尾"
) {
  const allTails = [
    "0","1","2","3","4",
    "5","6","7","8","9"
  ];

  const expectedCount =
    category === "八尾" ? 8 :
    category === "七尾" ? 7 :
    6;

  const excludedCount = 10 - expectedCount;

  const tailMatch = rawText.match(
    /[\(（]([^()（）]+)[\)）]/
  );

  if (!tailMatch) {
    return {
      supported: true,
      valid: false,
      reason: "TAIL_EXCLUSION_NOT_FOUND"
    };
  }

  const killed = Array.from(
    tailMatch[1].matchAll(/\d/g),
    (match) => match[0]
  );

  const uniqueKilled = Array.from(new Set(killed)).sort();

  if (uniqueKilled.length !== excludedCount) {
    return {
      supported: true,
      valid: false,
      reason: "TAIL_EXCLUSION_COUNT_MISMATCH",
      excluded: uniqueKilled
    };
  }

  const expected = allTails
    .filter((tail) => !uniqueKilled.includes(tail))
    .sort();

  const normalizedActual = [...actual].sort();

  return {
    supported: true,
    valid:
      normalizedActual.length === expectedCount &&
      JSON.stringify(normalizedActual) ===
        JSON.stringify(expected),
    expected,
    actual: normalizedActual,
    excluded: uniqueKilled
  };
}
  return {
  supported: false,
  valid: false,
  reason: "CATEGORY_NOT_SUPPORTED"
};
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
  ALTER TABLE records
  ADD COLUMN IF NOT EXISTS period_no INTEGER,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS subtype TEXT,
  ADD COLUMN IF NOT EXISTS source_name TEXT,
  ADD COLUMN IF NOT EXISTS source_order INTEGER,
  ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS item_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS raw_text TEXT,
  ADD COLUMN IF NOT EXISTS record_key TEXT,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
`;

await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS records_batch_record_key_uidx
  ON records (batch_id, record_key)
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
  await sql`ALTER TABLE recognition_jobs ADD COLUMN IF NOT EXISTS period_no INTEGER`;
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
    const periodNo = Number(form.get("period_no") || 0);
    const files = form
      .getAll("files")
      .filter((item): item is File => item instanceof File);

    if (!batchId) {
      return c.json({
        ok: false,
        error: "batch_id is required"
      }, 400);
    }
    
if (!periodNo) {
  return c.json({
    ok: false,
    error: "period_no is required"
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
    image_id,
    period_no
  )
  VALUES (
    ${batchId},
    ${imageId},
    ${periodNo}
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
      period_no: periodNo,
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
          j.period_no,
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
          j.period_no,
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
          j.period_no,
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
          j.period_no,
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
const runRecognitionJob = async (c: any) => {
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
        j.period_no,
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
// 同一张图片重新识别时，先清除旧识别结果，
    // 防止重复运行任务造成 records 不断叠加。
    await sql`
      DELETE FROM records
      WHERE image_id = ${image.image_id}
        AND batch_id = ${image.batch_id}
    `;
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
      const boundPeriodNo = Number(image.period_no);

      if (Number.isInteger(boundPeriodNo) && periodNo !== boundPeriodNo) {
        continue;
      }

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
};
      app.get("/api/recognition/analyze", runRecognitionJob);
    app.get("/api/recognition/start", async (c) => {
  const jobId = Number(c.req.query("job_id") || 0);

  if (!jobId) {
    return c.json({
      ok: false,
      error: "job_id is required"
    }, 400);
  }

  // 直接在当前服务内部运行识别，
  // 不再通过 HTTP 请求 /api/recognition/analyze
  void runRecognitionJob(c).catch((error) => {
    console.error("Background recognition failed:", error);
  });

  return c.json({
    ok: true,
    job_id: jobId,
    status: "STARTED"
  });
});
  

  
    
      
      
  
  

  
  
  

  
    
  

  
    
    
    
  

      app.get("/api/recognition/records", async (c) => {
  try {
    const imageId = Number(c.req.query("image_id") || 0);
const category = String(c.req.query("category") || "").trim();
    const periodNo = Number(c.req.query("period_no") || 0);
    if (!imageId) {
      return c.json({
        ok: false,
        error: "image_id is required"
      }, 400);
    }

    const records = await sql`
      SELECT
        id,
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
        review_status,
        created_at
      
      
  FROM records

WHERE image_id = ${imageId}
AND (${category} = '' OR category = ${category})
AND (${periodNo} = 0 OR period_no = ${periodNo})
ORDER BY period_no ASC, source_order ASC, id ASC
      
    `;

    return c.json({
      ok: true,
      image_id: imageId,
      count: records.length,
      records
    });
  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
        });
app.get("/api/recognition/records-by-category", async (c) => {
  try {
    const category = String(c.req.query("category") || "").trim();

    if (!category) {
      return c.json({
        ok: false,
        error: "category is required"
      }, 400);
    }

    const rows = await sql`
      SELECT
        id,
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
        review_status,
        created_at
      FROM records
      WHERE category = ${category}
      ORDER BY image_id ASC, period_no ASC, source_order ASC, id ASC
    `;

    return c.json({
      ok: true,
      category,
      count: rows.length,
      records: rows
    });
  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
    
});
      app.get("/api/recognition/records-summary", async (c) => {
  try {
    const imageId = Number(c.req.query("image_id") || 0);


    if (!imageId) {
      return c.json({
        ok: false,
        error: "image_id is required"
      }, 400);
    }

    const rows = await sql`
      SELECT
        period_no,
        COUNT(*)::int AS record_count,
        json_agg(
          json_build_object(
            'id', id,
            'category', category,
            'source_name', source_name,
            'items', items,
            'item_count', item_count,
            'raw_text', raw_text,
            'review_status', review_status,
            'created_at', created_at
          )
          ORDER BY id
        ) AS versions
      FROM records
      WHERE image_id = ${imageId}
      GROUP BY period_no
      ORDER BY period_no ASC
    `;

    return c.json({
      ok: true,
      image_id: imageId,
      periods_count: rows.length,
      periods: rows
    });
  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
});
app.get("/api/recognition/liuxiao-summary", async (c) => {
  try {
     
    const periodNo = Number(c.req.query("period_no") || 0);

    if (!periodNo) {
      return c.json({
        ok: false,
        error: "period_no is required"
      }, 400);
    }

    const rows = await sql`
      SELECT
        id,
        source_name,
        source_order,
        items,
        raw_text
      FROM records
      
        WHERE period_no = ${periodNo}
        AND category = '六肖'
      ORDER BY source_order ASC, id ASC
    `;
    const seen = new Set<string>();
    const duplicateRows: any[] = [];

const uniqueRows = rows.filter((row: any) => {
  const key = [
    String(row.source_name || "").trim(),
    Number(row.source_order || 0),
    JSON.stringify(row.items)
  ].join("|");
if (seen.has(key)) {
  duplicateRows.push(row);
  return false;
}
  
    
  

  seen.add(key);
  return true;
});

    const zodiacOrder = [
      "鼠", "牛", "虎", "兔", "龙", "蛇",
      "马", "羊", "猴", "鸡", "狗", "猪"
    ];

    const counts: Record<string, number> = {};
    for (const zodiac of zodiacOrder) {
      counts[zodiac] = 0;
    }

    let totalCells = 0;

    for (const row of uniqueRows) {
      let items = row.items;

      if (typeof items === "string") {
        try {
          items = JSON.parse(items);
        } catch {
          items = [];
        }
      }

      if (!Array.isArray(items)) {
        continue;
      }

      for (const item of items) {
        const zodiac = String(item).trim();

        if (zodiacOrder.includes(zodiac)) {
          counts[zodiac] += 1;
          totalCells += 1;
        }
      }
    }

    const ranking = zodiacOrder
      .map((zodiac) => ({
        zodiac,
        count: counts[zodiac]
      }))
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return zodiacOrder.indexOf(a.zodiac) -
          zodiacOrder.indexOf(b.zodiac);
      });

    let previousCount: number | null = null;
    let previousRank = 0;

    const competitionRanking = ranking.map((row, index) => {
      if (previousCount === null || row.count !== previousCount) {
        previousRank = index + 1;
        previousCount = row.count;
      }

      return {
        rank: previousRank,
        zodiac: row.zodiac,
        count: row.count
      };
    });

    return c.json({
      ok: true,
      
period_no: periodNo,
category: "六肖",
      raw_group_count: rows.length,
duplicate_count: rows.length - uniqueRows.length,
      duplicates: duplicateRows,
 group_count: uniqueRows.length,
total_cells: totalCells,
 expected_cells: uniqueRows.length * 6,
cells_valid: totalCells === uniqueRows.length * 6,
counts,
ranking: competitionRanking,
groups: uniqueRows
});
} catch (error) {
  return c.json({
    ok: false,
    error: String(error)
  }, 500);
}
});
      app.get("/api/recognition/validate-tail", async (c) => {
  try {
    const imageId = Number(c.req.query("image_id") || 0);
const category = String(c.req.query("category") || "八尾");

if (!["八尾", "七尾", "六尾"].includes(category)) {
  return c.json({
    ok: false,
    error: "category must be 八尾, 七尾 or 六尾"
  }, 400);
}
    if (!imageId) {
      return c.json({
        ok: false,
        error: "image_id is required"
      }, 400);
    }

    const rows = await sql`
      SELECT
        id,
        period_no,
        category,
        source_name,
        items,
        item_count,
        raw_text,
        review_status,
        created_at
      FROM records
      WHERE image_id = ${imageId}
        AND category = ${category}
      ORDER BY period_no ASC, id ASC
    `;

    const results = rows.map((row: any) => {
  const validation = validateRecognitionRecord(row);

  return {
    id: row.id,
    period_no: row.period_no,
    raw_text: row.raw_text,
    killed: validation.excluded ?? [],
    expected: validation.expected ?? [],
    actual: validation.actual ?? [],
    valid: validation.valid === true
  };
});

    
      

      
      
      

      
        
          
        
          
          
          
      
      

      
        

      
        
      

      


  
    
  
    
  


  
  
        
        

      
        
      

      
        
        
        
        
        
        
        
      
  

    const validRows = results.filter(
      (row: any) => row.valid === true
    );
const periodSummary = Array.from(
  new Set(results.map((row: any) => row.period_no))
)
  .sort((a: any, b: any) => a - b)
  .map((periodNo: any) => {
    const periodRows = results.filter(
      (row: any) => row.period_no === periodNo
    );

    const validPeriodRows = periodRows.filter(
      (row: any) => row.valid === true
    );

    return {
      period_no: periodNo,
      total_versions: periodRows.length,
      valid_versions: validPeriodRows.length,
      valid_ids: validPeriodRows.map(
        (row: any) => row.id
      )
    };
  });

const missingPeriods = periodSummary.filter(
  (row: any) => row.valid_versions === 0
);
   const keepPlan = periodSummary.map((row: any) => {
  const sortedValidIds = [...row.valid_ids]
    .map(Number)
    .sort((a: number, b: number) => a - b);

  return {
    period_no: row.period_no,
    keep_id: sortedValidIds[0] ?? null,
    valid_ids: sortedValidIds
  };
});

const keepIds = keepPlan
  .map((row: any) => row.keep_id)
  .filter((id: any) => id !== null);

const deleteIds = results
  .map((row: any) => Number(row.id))
  .filter((id: number) => !keepIds.includes(id));
    return c.json({
      ok: true,
      image_id: imageId,
      checked_count: results.length,
      valid_count: validRows.length,
      invalid_count: results.length - validRows.length,
     periods_total: periodSummary.length,
periods_with_valid: periodSummary.length - missingPeriods.length,
periods_missing_valid: missingPeriods.length,
period_summary: periodSummary,
missing_periods: missingPeriods,
     keep_count: keepIds.length,
delete_count: deleteIds.length,
keep_plan: keepPlan,
keep_ids: keepIds,
delete_ids: deleteIds,
      results
    });
  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
});
       app.get("/api/recognition/cleanup-tail-preview", async (c) => {
  try {
    const imageId = Number(c.req.query("image_id") || 0);

    if (imageId !== 2) {
      return c.json({
        ok: false,
        error: "cleanup preview only allows image_id=2"
      }, 400);
    }

    const rows = await sql`
      SELECT
        id,
        period_no,
        items,
        raw_text
      FROM records
      WHERE image_id = ${imageId}
        AND category = '八尾'
      ORDER BY period_no ASC, id ASC
    `;

    const allTails = [
      "0","1","2","3","4",
      "5","6","7","8","9"
    ];

    const checked = rows.map((row: any) => {
      const rawText = String(row.raw_text || "");

      const match = rawText.match(
        /(?:期)?\s*[\(（]\s*(\d)\s*[.,，、]\s*(\d)\s*尾?\s*[\)）]/
      );

      if (!match) {
        return {
          id: Number(row.id),
          period_no: row.period_no,
          valid: false
        };
      }

      const killed = [match[1], match[2]].sort();

      const expected = allTails.filter(
        (tail) => !killed.includes(tail)
      );

      let parsedItems: any = row.items;

      if (typeof parsedItems === "string") {
        try {
          parsedItems = JSON.parse(parsedItems);
        } catch {
          parsedItems = [];
        }
      }

      const actual = Array.isArray(parsedItems)
        ? parsedItems.map(String).sort()
        : [];

      const valid =
        actual.length === 8 &&
        JSON.stringify(actual) === JSON.stringify(expected);

      return {
        id: Number(row.id),
        period_no: row.period_no,
        valid
      };
    });

    const periods = Array.from(
      new Set(checked.map((row: any) => row.period_no))
    ).sort((a: any, b: any) => a - b);

    const keepPlan = periods.map((periodNo: any) => {
      const validRows = checked
        .filter(
          (row: any) =>
            row.period_no === periodNo &&
            row.valid === true
        )
        .sort(
          (a: any, b: any) => a.id - b.id
        );

      return {
        period_no: periodNo,
        keep_id: validRows[0]?.id ?? null,
        valid_ids: validRows.map(
          (row: any) => row.id
        )
      };
    });

    const missingPeriods = keepPlan.filter(
      (row: any) => row.keep_id === null
    );

    const keepIds = keepPlan
      .map((row: any) => row.keep_id)
      .filter((id: any) => id !== null);

    const deleteIds = checked
      .map((row: any) => row.id)
      .filter(
        (id: number) => !keepIds.includes(id)
      );

    return c.json({
      ok: true,
      image_id: imageId,
      checked_count: checked.length,
      periods_total: periods.length,
      periods_missing_valid: missingPeriods.length,
      keep_count: keepIds.length,
      delete_count: deleteIds.length,
      keep_plan: keepPlan,
      keep_ids: keepIds,
      delete_ids: deleteIds
    });
  } catch (error) {
    return c.json({
      ok: false,
      error: String(error)
    }, 500);
  }
});
      app.get("/api/recognition/cleanup-tail", async (c) => {
  try {
    const imageId = Number(c.req.query("image_id") || 0);
    const confirm = String(c.req.query("confirm") || "");

    if (imageId !== 2) {
      return c.json({
        ok: false,
        error: "cleanup only allows image_id=2"
      }, 400);
    }

    const rows = await sql`
      SELECT
        id,
        period_no,
        items,
        raw_text
      FROM records
      WHERE image_id = ${imageId}
        AND category = '八尾'
      ORDER BY period_no ASC, id ASC
    `;

    const allTails = [
      "0","1","2","3","4",
      "5","6","7","8","9"
    ];

    const checked = rows.map((row: any) => {
      const rawText = String(row.raw_text || "");
const match = rawText.match(
  /(?:期)?\s*[\(（]\s*(\d)\s*[.,，、]\s*(\d)\s*尾?\s*[\)）]/
);
      
        
      

      if (!match) {
        return {
          id: Number(row.id),
          period_no: row.period_no,
          valid: false
        };
      }

      const killed = [match[1], match[2]].sort();

      const expected = allTails.filter(
        (tail) => !killed.includes(tail)
      );

      let parsedItems: any = row.items;

      if (typeof parsedItems === "string") {
        try {
          parsedItems = JSON.parse(parsedItems);
        } catch {
          parsedItems = [];
        }
      }

      const actual = Array.isArray(parsedItems)
        ? parsedItems.map(String).sort()
        : [];

      const valid =
        actual.length === 8 &&
        JSON.stringify(actual) === JSON.stringify(expected);

      return {
        id: Number(row.id),
        period_no: row.period_no,
        valid
      };
    });

    const periods = Array.from(
      new Set(checked.map((row: any) => row.period_no))
    ).sort((a: any, b: any) => a - b);

    const keepPlan = periods.map((periodNo: any) => {
      const validRows = checked
        .filter(
          (row: any) =>
            row.period_no === periodNo &&
            row.valid === true
        )
        .sort((a: any, b: any) => a.id - b.id);

      return {
        period_no: periodNo,
        keep_id: validRows[0]?.id ?? null
      };
    });

    const missingPeriods = keepPlan.filter(
      (row: any) => row.keep_id === null
    );

    const keepIds = keepPlan
      .map((row: any) => row.keep_id)
      .filter((id: any) => id !== null);

    const deleteIds = checked
      .map((row: any) => row.id)
      .filter((id: number) => !keepIds.includes(id));

    const expectedKeepIds = Array.from(
      { length: 24 },
      (_, index) => index + 1
    );

    const safe =
      checked.length === 74 &&
      periods.length === 24 &&
      missingPeriods.length === 0 &&
      keepIds.length === 24 &&
      deleteIds.length === 50 &&
      JSON.stringify(keepIds) === JSON.stringify(expectedKeepIds);

    if (!safe) {
      return c.json({
        ok: false,
        error: "SAFETY_CHECK_FAILED",
        checked_count: checked.length,
        periods_total: periods.length,
        periods_missing_valid: missingPeriods.length,
        keep_count: keepIds.length,
        delete_count: deleteIds.length,
        keep_ids: keepIds
      }, 409);
    }

    if (confirm !== "DELETE_50_KEEP_24") {
      return c.json({
        ok: true,
        ready: true,
        executed: false,
        checked_count: 74,
        periods_total: 24,
        keep_count: 24,
        delete_count: 50,
        keep_ids: keepIds,
        message: "Confirmation required"
      });
    }

    const deleted = await sql`
      DELETE FROM records
      WHERE image_id = ${imageId}
        AND category = '八尾'
        AND id > 24
      RETURNING id
    `;

    const remaining = await sql`
      SELECT id, period_no
      FROM records
      WHERE image_id = ${imageId}
        AND category = '八尾'
      ORDER BY id ASC
    `;

    return c.json({
  ok: true,
  executed: true,
  deleted_count: deleted.length,
  remaining_count: remaining.length,
  remaining
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
app.get("/upload", (c) => {
  return c.html(`
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>总主表图片上传</title>
</head>
<body style="font-family:sans-serif;padding:24px;max-width:600px;margin:auto">
  <h2>总主表图片上传</h2>

  <form action="/api/images/upload" method="post" enctype="multipart/form-data">
    <p>
      <label>批次 ID：</label><br>
      <input
        type="number"
        name="batch_id"
        value="7"
        required
        style="font-size:18px;padding:8px;width:100%"
      >
      </p>
    <p>
  <label>期数：</label><br>
  <input
    type="number"
    name="period_no"
    placeholder="例如 275"
    required
    style="font-size:18px;padding:8px"
  >
</p>
    






    <p>
      <label>选择图片：</label><br><br>
      <input
        type="file"
        name="files"
        accept="image/*"
        multiple
        required
        style="font-size:18px"
      >
    </p>

    <button
      type="submit"
      style="font-size:20px;padding:12px 24px"
    >
      上传图片
    </button>
  </form>

  <p style="margin-top:25px">
    上传成功后会返回 image_id，并自动建立识别任务。
  </p>
</body>
</html>
  `);
});
app.get("/liuxiao", async (c) => {
  const periodNo = Number(c.req.query("period_no") || 0);

  if (!periodNo) {
    return c.html(`
      <html>
        <head>
          <meta charset="utf-8">
          <title>六肖统计</title>
        </head>
        <body style="font-family:sans-serif;padding:20px">
          <h2>六肖统计</h2>
          <form method="get">
            <input
              name="period_no"
              type="number"
              placeholder="输入期数，例如275"
              style="font-size:20px;padding:10px"
            >
            <button
              type="submit"
              style="font-size:20px;padding:10px"
            >
              查询
            </button>
          </form>
        </body>
      </html>
    `);
  }

  const url = new URL(c.req.url);
  url.pathname = "/api/recognition/liuxiao-summary";
  url.search = `?period_no=${periodNo}`;

  const response = await fetch(url.toString());
  const data: any = await response.json();

  if (!data.ok) {
    return c.html(`<h2>查询失败：${data.error || "未知错误"}</h2>`);
  }

  const rankingHtml = (data.ranking || [])
    .map(
      (row: any) =>
        `<tr>
          <td>${row.rank}</td>
          <td>${row.zodiac}</td>
          <td>${row.count}</td>
        </tr>`
    )
    .join("");

  const duplicateHtml = (data.duplicates || [])
    .map(
      (row: any) =>
        `<li>
          ID ${row.id} ｜ ${row.source_name || "未知来源"}
          ｜第${row.source_order || 0}组
          ｜${Array.isArray(row.items) ? row.items.join("、") : row.items}
        </li>`
    )
    .join("");

  return c.html(`
    <html>
      <head>
        <meta charset="utf-8">
        <title>第${periodNo}期六肖统计</title>
      </head>

      <body style="font-family:sans-serif;padding:20px;line-height:1.7">
        <h2>第${periodNo}期 · 六肖统计</h2>

        <p>
          原始组数：${data.raw_group_count}<br>
          重复组数：${data.duplicate_count}<br>
          有效组数：${data.group_count}<br>
          有效格数：${data.total_cells}<br>
          校验：${data.cells_valid ? "通过" : "异常"}
        </p>

        <h3>竞争排名</h3>

        <table border="1" cellpadding="8" cellspacing="0">
          <tr>
            <th>名次</th>
            <th>生肖</th>
            <th>次数</th>
          </tr>
          ${rankingHtml}
        </table>

        <h3>重复资料</h3>
        <ul>
          ${duplicateHtml || "<li>无重复资料</li>"}
        </ul>

        <hr>

        <form method="get">
          <input
            name="period_no"
            type="number"
            placeholder="输入其他期数"
            style="font-size:18px;padding:8px"
          >
          <button type="submit" style="font-size:18px;padding:8px">
            查询
          </button>
        </form>
      </body>
    </html>
  `);
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
