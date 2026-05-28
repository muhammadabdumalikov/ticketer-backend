import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);

  // ─────────────────────────────  users  ─────────────────────────────
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull().check(sql`role IN ('teacher','admin')`))
    .addColumn('department', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // ───────────────────────────  subjects  ───────────────────────────
  await db.schema
    .createTable('subjects')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('teacher_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('code', 'text', (c) => c.notNull())
    .addColumn('sigil', 'text', (c) => c.notNull())
    .addColumn('color', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('active').check(sql`status IN ('active','live','draft')`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_subjects_teacher').on('subjects').column('teacher_id').execute();
  await db.schema.createIndex('idx_subjects_code').on('subjects').column('code').execute();

  // ───────────────────────────  tickets  ────────────────────────────
  await db.schema
    .createTable('tickets')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('subject_id', 'uuid', (c) => c.notNull().references('subjects.id').onDelete('cascade'))
    .addColumn('author_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('restrict'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('duration_min', 'integer', (c) => c.notNull().defaultTo(90))
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('visibility', 'text', (c) => c.notNull().defaultTo('private').check(sql`visibility IN ('private','department','public')`))
    .addColumn('shuffle_mode', 'text', (c) => c.notNull().defaultTo('fixed').check(sql`shuffle_mode IN ('fixed','shuffle','random-bank')`))
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('Черновик').check(sql`status IN ('Черновик','Опубликован','Запланирован','Архив')`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_tickets_subject').on('tickets').column('subject_id').execute();
  await db.schema.createIndex('idx_tickets_author').on('tickets').column('author_id').execute();
  await db.schema.createIndex('idx_tickets_status').on('tickets').column('status').execute();

  // ──────────────────────────  questions  ───────────────────────────
  await db.schema
    .createTable('questions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('ticket_id', 'uuid', (c) => c.notNull().references('tickets.id').onDelete('cascade'))
    .addColumn('position', 'integer', (c) => c.notNull())
    .addColumn('type', 'text', (c) => c.notNull().check(sql`type IN ('single','multi','text','numeric','verbal')`))
    .addColumn('text', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('points', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('time_sec', 'integer', (c) => c.notNull().defaultTo(60))
    .addColumn('difficulty', 'text', (c) => c.notNull().defaultTo('medium').check(sql`difficulty IN ('easy','medium','hard')`))
    .addColumn('payload', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_questions_ticket_position', ['ticket_id', 'position'])
    .execute();

  // ──────────────────────────  sessions  ────────────────────────────
  await db.schema
    .createTable('sessions')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('ticket_id', 'uuid', (c) => c.notNull().references('tickets.id').onDelete('cascade'))
    .addColumn('teacher_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('restrict'))
    .addColumn('scheduled_at', 'timestamptz')
    .addColumn('started_at', 'timestamptz')
    .addColumn('ended_at', 'timestamptz')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('scheduled').check(sql`status IN ('scheduled','live','finished')`))
    .addColumn('tickets_policy', 'text', (c) => c.notNull().defaultTo('one-per-student').check(sql`tickets_policy IN ('one-per-student','allow-duplicates')`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_sessions_ticket').on('sessions').column('ticket_id').execute();
  await db.schema.createIndex('idx_sessions_teacher').on('sessions').column('teacher_id').execute();
  await db.schema.createIndex('idx_sessions_status').on('sessions').column('status').execute();

  // ────────────────────────  room_members  ─────────────────────────
  await db.schema
    .createTable('room_members')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('session_id', 'uuid', (c) => c.notNull().references('sessions.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('group_name', 'text', (c) => c.notNull())
    .addColumn('student_number', 'text')
    .addColumn('online', 'boolean', (c) => c.notNull().defaultTo(true))
    .addColumn('assigned_ticket_id', 'uuid', (c) => c.references('tickets.id').onDelete('set null'))
    .addColumn('session_token_hash', 'text', (c) => c.notNull())
    .addColumn('joined_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_room_members_session_token', ['session_id', 'session_token_hash'])
    .addUniqueConstraint('uq_room_members_session_identity', ['session_id', 'name', 'group_name'])
    .execute();
  await db.schema.createIndex('idx_room_members_session').on('room_members').column('session_id').execute();

  // ───────────────────────────  answers  ────────────────────────────
  await db.schema
    .createTable('answers')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('session_id', 'uuid', (c) => c.notNull().references('sessions.id').onDelete('cascade'))
    .addColumn('room_member_id', 'uuid', (c) => c.notNull().references('room_members.id').onDelete('cascade'))
    .addColumn('question_id', 'uuid', (c) => c.notNull().references('questions.id').onDelete('cascade'))
    .addColumn('selected_index', 'integer')
    .addColumn('selected_indices', 'jsonb')
    .addColumn('text_value', 'text')
    .addColumn('numeric_value', sql`double precision`)
    .addColumn('started_at', 'timestamptz')
    .addColumn('ended_at', 'timestamptz')
    .addColumn('duration_sec', 'integer')
    .addColumn('notes', 'text')
    .addColumn('points_awarded', 'integer')
    .addColumn('graded_by', 'uuid', (c) => c.references('users.id').onDelete('set null'))
    .addColumn('graded_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_answers_session_member_question', ['session_id', 'room_member_id', 'question_id'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('answers').ifExists().execute();
  await db.schema.dropTable('room_members').ifExists().execute();
  await db.schema.dropTable('sessions').ifExists().execute();
  await db.schema.dropTable('questions').ifExists().execute();
  await db.schema.dropTable('tickets').ifExists().execute();
  await db.schema.dropTable('subjects').ifExists().execute();
  await db.schema.dropTable('users').ifExists().execute();
}
