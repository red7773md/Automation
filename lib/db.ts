import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

// Plain row arrays (not the union the default generics produce).
type Sql = NeonQueryFunction<false, false>;

let client: Sql | undefined;
let ready: Promise<void> | undefined;

// Runs once per server instance. Safe to repeat: every statement is "if not exists".
const DDL = [
  `create table if not exists jobs (
     id uuid primary key default gen_random_uuid(),
     topic text not null,
     state text not null default 'queued',
     busy boolean not null default false,
     attempts int not null default 0,
     data jsonb not null default '{}'::jsonb,
     error text,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,
  `create table if not exists job_logs (
     id bigserial primary key,
     job_id uuid not null references jobs(id) on delete cascade,
     level text not null default 'info',
     step text not null,
     message text not null,
     detail text,
     duration_ms int,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists job_logs_job_idx on job_logs (job_id, id)`,
  `alter table jobs add column if not exists scheduled_at timestamptz not null default now()`,
  `create index if not exists jobs_due_idx on jobs (state, scheduled_at)`,
  `create table if not exists app_settings (
     key text primary key,
     value jsonb not null,
     updated_at timestamptz not null default now()
   )`,
  `create table if not exists provider_secrets (
     provider text primary key,
     ciphertext text not null,
     cookie_names text not null,
     updated_at timestamptz not null default now()
   )`,
];

function raw(): Sql {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    client = neon<false, false>(url);
  }
  return client;
}

export async function getDb(): Promise<Sql> {
  if (!ready) {
    ready = (async () => {
      const db = raw();
      for (const statement of DDL) await db.query(statement);
    })().catch((err) => {
      ready = undefined;
      throw err;
    });
  }
  await ready;
  return raw();
}
