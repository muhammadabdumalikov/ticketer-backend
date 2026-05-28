import 'dotenv/config';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import * as bcrypt from 'bcryptjs';
import type { DB } from './schema';

const SUBJECTS = [
  { name: 'Теория вероятностей и статистика', code: 'MATH-301', sigil: 'ТВ', color: '#FF4D1F', status: 'live' as const },
  { name: 'Дискретная математика', code: 'CS-204', sigil: 'ДМ', color: '#1F9D55', status: 'active' as const },
  { name: 'Линейная алгебра', code: 'MATH-220', sigil: 'ЛА', color: '#6F46D7', status: 'active' as const },
  { name: 'Алгоритмы и структуры данных', code: 'CS-310', sigil: 'АС', color: '#0F62FE', status: 'draft' as const },
  { name: 'Численные методы', code: 'MATH-340', sigil: 'ЧМ', color: '#0A8F90', status: 'active' as const },
  { name: 'Математическая логика', code: 'MATH-251', sigil: 'МЛ', color: '#D43872', status: 'active' as const },
];

const MATH301_TICKETS = [
  { title: 'Весенний итоговый экзамен', durationMin: 90, status: 'Запланирован' as const },
  { title: 'Промежуточный — Байесов анализ', durationMin: 45, status: 'Опубликован' as const },
  { title: 'Пробный — Случайные величины', durationMin: 30, status: 'Черновик' as const },
  { title: 'Пересдача — Цепи Маркова', durationMin: 60, status: 'Архив' as const },
];

const SAMPLE_QUESTIONS = [
  {
    type: 'single', text: 'Чему равна сумма вероятностей всех элементарных исходов?', points: 5, timeSec: 60,
    difficulty: 'easy', payload: { answers: ['0', '0.5', '1', '∞'], correct: 2 },
  },
  {
    type: 'verbal', text: 'Расскажите о свойствах нормального распределения. Связь с ЦПТ. Примеры применения.',
    points: 10, timeSec: 300, difficulty: 'medium',
    payload: { rubric: 'Параметры μ и σ; правило 68-95-99,7; ЦПТ; пример (контроль качества, IQ).' },
  },
];

async function main() {
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: process.env.DATABASE_URL ?? 'postgresql://ticketer:ticketer@localhost:5432/ticketer',
      }),
    }),
    plugins: [new CamelCasePlugin()],
  });

  console.log('Wiping existing data…');
  await db.deleteFrom('answers').execute();
  await db.deleteFrom('roomMembers').execute();
  await db.deleteFrom('sessions').execute();
  await db.deleteFrom('questions').execute();
  await db.deleteFrom('tickets').execute();
  await db.deleteFrom('subjects').execute();
  await db.deleteFrom('users').execute();

  console.log('Creating teacher user…');
  const passwordHash = await bcrypt.hash('password', 10);
  const teacher = await db
    .insertInto('users')
    .values({
      email: 'teacher@example.com',
      passwordHash,
      name: 'Д-р Елена Новик',
      role: 'teacher',
      department: 'Информатика',
    } as any)
    .returning(['id'])
    .executeTakeFirstOrThrow();
  console.log(`  • teacher@example.com / password  (id=${teacher.id})`);

  console.log('Inserting subjects…');
  const insertedSubjects = await db
    .insertInto('subjects')
    .values(SUBJECTS.map((s) => ({ ...s, teacherId: teacher.id })) as any)
    .returning(['id', 'code'])
    .execute();

  const math301 = insertedSubjects.find((s) => s.code === 'MATH-301');
  if (!math301) throw new Error('MATH-301 subject not found after insert');

  console.log('Inserting tickets for MATH-301…');
  for (const t of MATH301_TICKETS) {
    const ticket = await db
      .insertInto('tickets')
      .values({
        subjectId: math301.id,
        authorId: teacher.id,
        title: t.title,
        durationMin: t.durationMin,
        status: t.status,
        description: '',
        attempts: 1,
        visibility: 'private',
        shuffleMode: 'fixed',
      } as any)
      .returning(['id'])
      .executeTakeFirstOrThrow();

    await db
      .insertInto('questions')
      .values(
        SAMPLE_QUESTIONS.map((q, i) => ({
          ticketId: ticket.id,
          position: i,
          type: q.type,
          text: q.text,
          points: q.points,
          timeSec: q.timeSec,
          difficulty: q.difficulty,
          payload: JSON.stringify(q.payload),
        })) as any,
      )
      .execute();
  }

  console.log('✅ Seed complete.');
  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
