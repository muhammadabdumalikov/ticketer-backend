import { Kysely, sql } from 'kysely';

/**
 * Introduce an `exams` layer between subjects and tickets.
 *
 * Hierarchy after this migration:
 *   subject → exam → ticket → questions
 *
 * Each existing ticket is auto-wrapped into a 1:1 exam: the exam owns
 * test-level params (title, description, duration, attempts, visibility,
 * shuffle, status). The ticket keeps only its label (`title`) and questions.
 *
 * Sessions gain an `exam_id` column backfilled from their ticket's new exam.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // 1) Create exams table.
  await db.schema
    .createTable('exams')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('subject_id', 'uuid', (c) => c.notNull().references('subjects.id').onDelete('cascade'))
    .addColumn('author_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('restrict'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('description', 'text', (c) => c.notNull().defaultTo(''))
    .addColumn('duration_min', 'integer', (c) => c.notNull().defaultTo(90))
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('visibility', 'text', (c) =>
      c.notNull().defaultTo('private').check(sql`visibility IN ('private','department','public')`),
    )
    .addColumn('shuffle_mode', 'text', (c) =>
      c.notNull().defaultTo('fixed').check(sql`shuffle_mode IN ('fixed','shuffle','random-bank')`),
    )
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('Черновик')
        .check(sql`status IN ('Черновик','Опубликован','Запланирован','Архив')`),
    )
    .addColumn('scheduled_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex('idx_exams_subject').on('exams').column('subject_id').execute();
  await db.schema.createIndex('idx_exams_author').on('exams').column('author_id').execute();
  await db.schema.createIndex('idx_exams_status').on('exams').column('status').execute();

  // 2) Add nullable exam_id to tickets so we can backfill.
  await db.schema.alterTable('tickets').addColumn('exam_id', 'uuid').execute();
  await db.schema
    .alterTable('tickets')
    .addColumn('position', 'integer', (c) => c.notNull().defaultTo(1))
    .execute();

  // 3) Backfill: for every existing ticket, create a 1:1 exam.
  await sql`
    INSERT INTO exams (id, subject_id, author_id, title, description, duration_min, attempts, visibility, shuffle_mode, status, created_at, updated_at)
    SELECT
      gen_random_uuid(),
      t.subject_id,
      t.author_id,
      t.title,
      t.description,
      t.duration_min,
      t.attempts,
      t.visibility,
      t.shuffle_mode,
      t.status,
      t.created_at,
      t.updated_at
    FROM tickets t
  `.execute(db);

  // Link each ticket to the exam created from it. Matching uses (subject_id,
  // author_id, title, created_at) — title is not unique, but the timestamp
  // distinguishes copies of the same name.
  await sql`
    UPDATE tickets t
    SET exam_id = e.id
    FROM exams e
    WHERE e.subject_id = t.subject_id
      AND e.author_id = t.author_id
      AND e.title = t.title
      AND e.created_at = t.created_at
  `.execute(db);

  // 4) Now make exam_id non-null and add foreign key + index.
  await sql`ALTER TABLE tickets ALTER COLUMN exam_id SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE tickets
    ADD CONSTRAINT fk_tickets_exam FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
  `.execute(db);
  await db.schema.createIndex('idx_tickets_exam').on('tickets').column('exam_id').execute();

  // 5) Rename existing ticket titles to "Билет №1" — the exam keeps the
  // descriptive title; the ticket label becomes a position-style name.
  await sql`UPDATE tickets SET title = 'Билет №1'`.execute(db);

  // 6) Drop ticket columns that now belong to the exam.
  await db.schema.alterTable('tickets').dropColumn('description').execute();
  await db.schema.alterTable('tickets').dropColumn('duration_min').execute();
  await db.schema.alterTable('tickets').dropColumn('attempts').execute();
  await db.schema.alterTable('tickets').dropColumn('visibility').execute();
  await db.schema.alterTable('tickets').dropColumn('shuffle_mode').execute();
  // Ticket-level status is no longer meaningful; the exam owns publishing state.
  await db.schema.alterTable('tickets').dropColumn('status').execute();

  // 7) Sessions gain exam_id (backfilled from their ticket).
  await db.schema.alterTable('sessions').addColumn('exam_id', 'uuid').execute();
  await sql`
    UPDATE sessions s
    SET exam_id = t.exam_id
    FROM tickets t
    WHERE t.id = s.ticket_id
  `.execute(db);
  await sql`ALTER TABLE sessions ALTER COLUMN exam_id SET NOT NULL`.execute(db);
  await sql`
    ALTER TABLE sessions
    ADD CONSTRAINT fk_sessions_exam FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
  `.execute(db);
  await db.schema.createIndex('idx_sessions_exam').on('sessions').column('exam_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  // Reverse: re-add ticket columns from their exam, drop sessions.exam_id, drop exams.
  await db.schema.alterTable('tickets').addColumn('description', 'text', (c) => c.notNull().defaultTo('')).execute();
  await db.schema.alterTable('tickets').addColumn('duration_min', 'integer', (c) => c.notNull().defaultTo(90)).execute();
  await db.schema.alterTable('tickets').addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(1)).execute();
  await db.schema
    .alterTable('tickets')
    .addColumn('visibility', 'text', (c) =>
      c.notNull().defaultTo('private').check(sql`visibility IN ('private','department','public')`),
    )
    .execute();
  await db.schema
    .alterTable('tickets')
    .addColumn('shuffle_mode', 'text', (c) =>
      c.notNull().defaultTo('fixed').check(sql`shuffle_mode IN ('fixed','shuffle','random-bank')`),
    )
    .execute();
  await db.schema
    .alterTable('tickets')
    .addColumn('status', 'text', (c) =>
      c
        .notNull()
        .defaultTo('Черновик')
        .check(sql`status IN ('Черновик','Опубликован','Запланирован','Архив')`),
    )
    .execute();
  await sql`
    UPDATE tickets t
    SET title = e.title,
        description = e.description,
        duration_min = e.duration_min,
        attempts = e.attempts,
        visibility = e.visibility,
        shuffle_mode = e.shuffle_mode,
        status = e.status
    FROM exams e
    WHERE e.id = t.exam_id
  `.execute(db);

  await sql`ALTER TABLE sessions DROP CONSTRAINT IF EXISTS fk_sessions_exam`.execute(db);
  await db.schema.dropIndex('idx_sessions_exam').ifExists().execute();
  await db.schema.alterTable('sessions').dropColumn('exam_id').execute();

  await sql`ALTER TABLE tickets DROP CONSTRAINT IF EXISTS fk_tickets_exam`.execute(db);
  await db.schema.dropIndex('idx_tickets_exam').ifExists().execute();
  await db.schema.alterTable('tickets').dropColumn('exam_id').execute();
  await db.schema.alterTable('tickets').dropColumn('position').execute();

  await db.schema.dropTable('exams').ifExists().execute();
}
