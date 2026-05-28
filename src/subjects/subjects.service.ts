import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { KYSELY, type Database } from '../db/database.module';
import type { CreateSubjectDto, UpdateSubjectDto } from './dto/subject.dto';

export interface SubjectDto {
  id: string;
  name: string;
  code: string;
  sigil: string;
  color: string;
  status: string;
  tickets: number;
  exams: number;
  students: number;
  progress: number;
}

@Injectable()
export class SubjectsService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async listForTeacher(teacherId: string): Promise<SubjectDto[]> {
    const rows = await this.db
      .selectFrom('subjects as s')
      .leftJoin('exams as e', 'e.subjectId', 's.id')
      .leftJoin('tickets as t', 't.subjectId', 's.id')
      .leftJoin('sessions as sn', 'sn.examId', 'e.id')
      .leftJoin('roomMembers as rm', 'rm.sessionId', 'sn.id')
      .select([
        's.id', 's.name', 's.code', 's.sigil', 's.color', 's.status',
        sql<number>`count(distinct t.id)::int`.as('tickets'),
        sql<number>`count(distinct e.id)::int`.as('exams'),
        sql<number>`count(distinct rm.id)::int`.as('students'),
      ])
      .where('s.teacherId', '=', teacherId)
      .groupBy(['s.id'])
      .orderBy('s.name')
      .execute();

    return rows.map((r) => ({
      ...r,
      progress: 0,
    }));
  }

  async getOne(teacherId: string, id: string): Promise<SubjectDto> {
    const all = await this.listForTeacher(teacherId);
    const found = all.find((s) => s.id === id);
    if (!found) throw new NotFoundException('Subject not found');
    return found;
  }

  async create(teacherId: string, dto: CreateSubjectDto): Promise<SubjectDto> {
    const row = await this.db
      .insertInto('subjects')
      .values({
        teacherId,
        name: dto.name,
        code: dto.code,
        sigil: dto.sigil,
        color: dto.color,
        status: dto.status ?? 'active',
      } as any)
      .returning(['id', 'name', 'code', 'sigil', 'color', 'status'])
      .executeTakeFirstOrThrow();
    return { ...row, tickets: 0, exams: 0, students: 0, progress: 0 };
  }

  async update(teacherId: string, id: string, dto: UpdateSubjectDto): Promise<SubjectDto> {
    await this.assertOwnership(teacherId, id);
    await this.db
      .updateTable('subjects')
      .set({ ...dto, updatedAt: new Date() })
      .where('id', '=', id)
      .execute();
    return this.getOne(teacherId, id);
  }

  async remove(teacherId: string, id: string): Promise<void> {
    await this.assertOwnership(teacherId, id);
    await this.db.deleteFrom('subjects').where('id', '=', id).execute();
  }

  /**
   * Seed a demo subject for the current teacher: one published exam with three
   * билетов, each carrying a small mix of question types. Useful for trying out
   * the launch / share / random-ticket flow end-to-end without hand-crafting
   * test data.
   */
  async createMock(teacherId: string): Promise<SubjectDto> {
    const codeSuffix = Math.floor(1000 + Math.random() * 9000);
    const subjectId = await this.db.transaction().execute(async (trx) => {
      // 1) subject
      const subj = await trx
        .insertInto('subjects')
        .values({
          teacherId,
          name: 'Демо: Основы алгоритмов',
          code: `DEMO-${codeSuffix}`,
          sigil: 'ДА',
          color: '#0F62FE',
          status: 'active',
        } as any)
        .returning(['id'])
        .executeTakeFirstOrThrow();

      // 2) exam
      const exam = await trx
        .insertInto('exams')
        .values({
          subjectId: subj.id,
          authorId: teacherId,
          title: 'Демо-экзамен — Алгоритмы и структуры данных',
          description:
            'Учебный пример, чтобы попробовать запуск, раздачу билетов и сбор ответов.',
          durationMin: 60,
          attempts: 1,
          visibility: 'private',
          shuffleMode: 'fixed',
          status: 'Опубликован',
        } as any)
        .returning(['id'])
        .executeTakeFirstOrThrow();

      // 3) tickets + questions
      const ticketSpecs = mockTickets();
      for (let i = 0; i < ticketSpecs.length; i++) {
        const ts = ticketSpecs[i];
        const ticket = await trx
          .insertInto('tickets')
          .values({
            examId: exam.id,
            subjectId: subj.id,
            authorId: teacherId,
            title: `Билет №${i + 1}`,
            position: i + 1,
          } as any)
          .returning(['id'])
          .executeTakeFirstOrThrow();

        const rows = ts.questions.map((q, idx) => ({
          ticketId: ticket.id,
          position: idx,
          type: q.type,
          text: q.text,
          points: q.points,
          timeSec: q.time,
          difficulty: q.difficulty,
          payload: JSON.stringify(q.payload),
        }));
        await trx.insertInto('questions').values(rows as any).execute();
      }

      return subj.id;
    });

    return this.getOne(teacherId, subjectId);
  }

  /** Remove all DEMO-* subjects belonging to this teacher (cascades exams/tickets/etc). */
  async removeMock(teacherId: string): Promise<{ removed: number }> {
    const rows = await this.db
      .deleteFrom('subjects')
      .where('teacherId', '=', teacherId)
      .where('code', 'like', 'DEMO-%')
      .returning(['id'])
      .execute();
    return { removed: rows.length };
  }

  private async assertOwnership(teacherId: string, id: string): Promise<void> {
    const row = await this.db
      .selectFrom('subjects')
      .select('teacherId')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Subject not found');
    if (row.teacherId !== teacherId) throw new ForbiddenException('Not your subject');
  }
}

interface MockQuestionSpec {
  type: 'single' | 'multi' | 'text' | 'numeric' | 'verbal';
  text: string;
  points: number;
  time: number;
  difficulty: 'easy' | 'medium' | 'hard';
  payload: Record<string, unknown>;
}

interface MockTicketSpec {
  questions: MockQuestionSpec[];
}

function mockTickets(): MockTicketSpec[] {
  return [
    {
      questions: [
        {
          type: 'single',
          text: 'Какая временная сложность бинарного поиска?',
          points: 5,
          time: 60,
          difficulty: 'easy',
          payload: { answers: ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], correct: 1 },
        },
        {
          type: 'numeric',
          text: 'Сколько узлов в полном двоичном дереве высоты 3 (корень — высота 0)?',
          points: 5,
          time: 90,
          difficulty: 'medium',
          payload: { expected: 15 },
        },
        {
          type: 'verbal',
          text: 'Объясните принцип работы алгоритма быстрой сортировки. Какая у него сложность в среднем случае?',
          points: 10,
          time: 180,
          difficulty: 'medium',
          payload: {
            rubric:
              'Должен упомянуть: выбор опорного элемента, разбиение, рекурсия, средняя сложность O(n log n).',
          },
        },
      ],
    },
    {
      questions: [
        {
          type: 'multi',
          text: 'Какие из сортировок имеют сложность O(n log n) в среднем случае?',
          points: 6,
          time: 90,
          difficulty: 'medium',
          payload: {
            answers: [
              'Пузырьковая сортировка',
              'Сортировка слиянием',
              'Быстрая сортировка',
              'Сортировка вставками',
            ],
            correct: [1, 2],
          },
        },
        {
          type: 'text',
          text: 'Что означает аббревиатура BST?',
          points: 4,
          time: 60,
          difficulty: 'easy',
          payload: { expected: 'Binary Search Tree' },
        },
        {
          type: 'verbal',
          text: 'Опишите разницу между стеком и очередью. Приведите примеры использования.',
          points: 10,
          time: 180,
          difficulty: 'medium',
          payload: {
            rubric: 'Стек — LIFO. Очередь — FIFO. Примеры: undo, печать, обход в ширину.',
          },
        },
      ],
    },
    {
      questions: [
        {
          type: 'single',
          text: 'Какая структура данных использует принцип FIFO?',
          points: 5,
          time: 60,
          difficulty: 'easy',
          payload: { answers: ['Стек', 'Очередь', 'Дерево', 'Граф'], correct: 1 },
        },
        {
          type: 'numeric',
          text: 'Сколько сравнений в худшем случае выполнит линейный поиск в массиве из 100 элементов?',
          points: 5,
          time: 60,
          difficulty: 'easy',
          payload: { expected: 100 },
        },
        {
          type: 'verbal',
          text: 'Что такое хеш-таблица? Какие коллизии могут возникнуть и как их разрешать?',
          points: 10,
          time: 180,
          difficulty: 'hard',
          payload: {
            rubric:
              'Хеш-функция, бакеты, методы разрешения коллизий: цепочки или открытая адресация.',
          },
        },
      ],
    },
  ];
}
