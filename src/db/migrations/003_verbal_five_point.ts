import { Kysely, sql } from 'kysely';

/**
 * Switch verbal (oral) grading from a 10-point to a 5-point scale.
 *
 * Verbal questions worth more than 5 points are capped at 5, and any grades
 * already awarded on them are rescaled proportionally (e.g. 8/10 → 4/5).
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    UPDATE answers a
    SET points_awarded = ROUND(a.points_awarded * 5.0 / q.points)
    FROM questions q
    WHERE q.id = a.question_id
      AND q.type = 'verbal'
      AND q.points > 5
      AND a.points_awarded IS NOT NULL
  `.execute(db);
  await sql`UPDATE questions SET points = 5 WHERE type = 'verbal' AND points > 5`.execute(db);
}

export async function down(): Promise<void> {
  // Original point values are not recoverable; nothing to undo.
}
