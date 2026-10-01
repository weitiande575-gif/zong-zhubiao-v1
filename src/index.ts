import { Hono } from "hono";
import { serve } from "bun";
import postgres from "postgres";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

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

const BUCKET_NAME = process.env.BUCKET_NAME;
const S3_ENDPOINT =
  process.env.AWS_S3_ENDPOINT_URL ||
  process.env.S3_ENDPOINT;

const S3_ACCESS_KEY =
  process.env.AWS_ACCESS_KEY_ID ||
  process.env.S3_ACCESS_KEY_ID;

const S3_SECRET_KEY =
  process.env.AWS_SECRET_ACCESS_KEY ||
  process.env.S3_SECRET_ACCESS_KEY;

const s3 =
  BUCKET_NAME &&
  S3_ENDPOINT &&
  S3_ACCESS_KEY &&
  S3_SECRET_KEY
    ? new S3Client({
        region: "auto",
        endpoint: S3_ENDPOINT,
        forcePathStyle: true,
        credentials: {
          accessKeyId: S3_ACCESS_KEY,
          secretAccessKey: S3_SECRET_KEY,
        },
      })
    : null;

const VALID_CATEGORIES = [
  "五行",
  "五头",
  "六肖",
  "双波",
  "八尾",
] as const;

const EXCLUDED_CATEGORIES = [
  "平特",
  "平特一肖",
];

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
      batch_id BIGINT NOT NULL
        REFERENCES batches(id)
        ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      storage_key TEXT NOT NULL UNIQUE,
      mime_type TEXT,
      size_bytes BIGINT,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS records (
      id BIGSERIAL PRIMARY KEY,
      image_id BIGINT NOT NULL
        REFERENCES images(id)
        ON DELETE CASCADE,
      period INTEGER,
      category TEXT,
      source_name TEXT,
      raw_text TEXT,
      parsed_data JSONB,
      confidence NUMERIC,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS reviews (
      id BIGSERIAL PRIMARY KEY,
      record_id BIGINT
        REFERENCES records(id)
        ON DELETE CASCADE,
      action TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id BIGSERIAL PRIMARY KEY,
      batch_id BIGINT
        REFERENCES batches(id)
        ON DELETE CASCADE,
      checkpoint_type TEXT NOT NULL,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_images_batch
    ON images(batch_id)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_records_image
    ON records(image_id)
  `;
}

function html() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport"
 content="width=device-width,initial-scale=1">
<title>总主表 V1</title>
<style>
body{
  margin:0;
  font-family:Arial,sans-serif;
  background:#f4f6f8;
  color:#17202a
}
.wrap{
  max-width:720px;
  margin:auto;
  padding:18px
}
header{
  background:#172333;
  color:white;
  padding:22px;
  border-radius:14px;
  text-align:center
}
.card{
  background:white;
  padding:18px;
  margin-top:16px;
  border-radius:14px;
  box-shadow:0 2px 10px #00000012
}
input,select,button{
  box-sizing:border-box;
  width:100%;
  padding:13px;
  margin-top:9px;
  border-radius:9px;
  border:1px solid #ccd3da;
  font-size:16px
}
button{
  background:#168ad0;
  color:white;
  border:0;
  font-weight:bold
}
.badge{
  display:inline-block;
  background:#edf1f4;
  padding:7px 11px;
  margin:4px;
  border-radius:18px
}
#msg{
  white-space:pre-wrap;
  margin-top:12px
}
</style>
</head>
<body>
<div class="wrap">

<header>
<h2>🎯 总主表</h2>
<div>Master API V1</div>
</header>

<div class="card">
<h3>① 创建批次</h3>
<input id="batchName"
 placeholder="例如：271期">
<button onclick="createBatch()">
创建批次
</button>
<div id="batchMsg"></div>
</div>

<div class="card">
<h3>② 上传原图</h3>

<select id="batchSelect">
<option value="">选择批次...</option>
</select>

<input id="files"
 type="file"
 accept="image/*"
 multiple>

<select id="category">
<option value="">选择分类...</option>
<option>五行</option>
<option>五头</option>
<option>六肖</option>
<option>双波</option>
<option>八尾</option>
</select>

<button onclick="uploadFiles()">
上传图片
</button>

<div id="msg"></div>
</div>

<div class="card">
<h3>有效分类</h3>
<span class="badge">五行</span>
<span class="badge">五头</span>
<span class="badge">六肖</span>
<span class="badge">双波</span>
<span class="badge">八尾</span>
<p>❌ 排除：平特、平特一肖</p >
<p>六肖：按实际有效来源累计，不设固定闭合组数。</p >
</div>

<div class="car
