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
  async createMock(teacherId: string, locale: DemoLocale = 'ru'): Promise<SubjectDto> {
    const t = (ru: string, uz: string) => (locale === 'uz' ? uz : ru);
    const codeSuffix = Math.floor(1000 + Math.random() * 9000);
    const subjectId = await this.db.transaction().execute(async (trx) => {
      // 1) subject
      const subj = await trx
        .insertInto('subjects')
        .values({
          teacherId,
          name: t('Демо: Основы алгоритмов', 'Demo: Algoritmlar asoslari'),
          code: `DEMO-${codeSuffix}`,
          sigil: t('ДА', 'DA'),
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
          title: t(
            'Демо-экзамен — Алгоритмы и структуры данных',
            "Demo-imtihon — Algoritmlar va ma'lumotlar tuzilmalari",
          ),
          description: t(
            'Учебный пример, чтобы попробовать запуск, раздачу билетов и сбор ответов.',
            "Ishga tushirish, biletlarni tarqatish va javoblarni yig'ishni sinab ko'rish uchun o'quv namunasi.",
          ),
          durationMin: 60,
          attempts: 1,
          visibility: 'private',
          shuffleMode: 'fixed',
          status: 'Опубликован',
        } as any)
        .returning(['id'])
        .executeTakeFirstOrThrow();

      // 3) tickets + questions
      const ticketSpecs = mockTickets(t);
      for (let i = 0; i < ticketSpecs.length; i++) {
        const ts = ticketSpecs[i];
        const ticket = await trx
          .insertInto('tickets')
          .values({
            examId: exam.id,
            subjectId: subj.id,
            authorId: teacherId,
            // canonical auto-title; clients show it in the viewer's language
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

type DemoLocale = 'ru' | 'uz';

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

/** `t(ru, uz)` picks the demo text in the teacher's interface language. */
function mockTickets(t: (ru: string, uz: string) => string): MockTicketSpec[] {
  return [
    {
      questions: [
        {
          type: 'single',
          text: t('Какая временная сложность бинарного поиска?', 'Ikkilik qidiruvning vaqt murakkabligi qanday?'),
          points: 5,
          time: 60,
          difficulty: 'easy',
          payload: { answers: ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], correct: 1 },
        },
        {
          type: 'numeric',
          text: t(
            'Сколько узлов в полном двоичном дереве высоты 3 (корень — высота 0)?',
            "Balandligi 3 bo'lgan to'liq ikkilik daraxtda nechta tugun bor (ildiz — balandlik 0)?",
          ),
          points: 5,
          time: 90,
          difficulty: 'medium',
          payload: { expected: 15 },
        },
        {
          type: 'verbal',
          text: t(
            'Объясните принцип работы алгоритма быстрой сортировки. Какая у него сложность в среднем случае?',
            "Tez saralash (quicksort) algoritmining ishlash tamoyilini tushuntiring. O'rtacha holatda uning murakkabligi qanday?",
          ),
          points: 5,
          time: 180,
          difficulty: 'medium',
          payload: {
            rubric: t(
              'Должен упомянуть: выбор опорного элемента, разбиение, рекурсия, средняя сложность O(n log n).',
              "Aytib o'tishi kerak: tayanch elementni tanlash, bo'lish, rekursiya, o'rtacha murakkablik O(n log n).",
            ),
          },
        },
      ],
    },
    {
      questions: [
        {
          type: 'multi',
          text: t(
            'Какие из сортировок имеют сложность O(n log n) в среднем случае?',
            "Qaysi saralash algoritmlari o'rtacha holatda O(n log n) murakkablikka ega?",
          ),
          points: 6,
          time: 90,
          difficulty: 'medium',
          payload: {
            answers: [
              t('Пузырьковая сортировка', 'Pufakchali saralash'),
              t('Сортировка слиянием', 'Birlashtirib saralash'),
              t('Быстрая сортировка', 'Tez saralash'),
              t('Сортировка вставками', "Qo'yib saralash"),
            ],
            correct: [1, 2],
          },
        },
        {
          type: 'text',
          text: t('Что означает аббревиатура BST?', 'BST qisqartmasi nimani anglatadi?'),
          points: 4,
          time: 60,
          difficulty: 'easy',
          payload: { expected: 'Binary Search Tree' },
        },
        {
          type: 'verbal',
          text: t(
            'Опишите разницу между стеком и очередью. Приведите примеры использования.',
            "Stek va navbat o'rtasidagi farqni tushuntiring. Qo'llanilishiga misollar keltiring.",
          ),
          points: 5,
          time: 180,
          difficulty: 'medium',
          payload: {
            rubric: t(
              'Стек — LIFO. Очередь — FIFO. Примеры: undo, печать, обход в ширину.',
              "Stek — LIFO. Navbat — FIFO. Misollar: undo, chop etish navbati, kenglik bo'yicha aylanib chiqish.",
            ),
          },
        },
      ],
    },
    {
      questions: [
        {
          type: 'single',
          text: t(
            'Какая структура данных использует принцип FIFO?',
            "Qaysi ma'lumotlar tuzilmasi FIFO tamoyilidan foydalanadi?",
          ),
          points: 5,
          time: 60,
          difficulty: 'easy',
          payload: {
            answers: [t('Стек', 'Stek'), t('Очередь', 'Navbat'), t('Дерево', 'Daraxt'), t('Граф', 'Graf')],
            correct: 1,
          },
        },
        {
          type: 'numeric',
          text: t(
            'Сколько сравнений в худшем случае выполнит линейный поиск в массиве из 100 элементов?',
            '100 elementli massivda chiziqli qidiruv eng yomon holatda nechta taqqoslash bajaradi?',
          ),
          points: 5,
          time: 60,
          difficulty: 'easy',
          payload: { expected: 100 },
        },
        {
          type: 'verbal',
          text: t(
            'Что такое хеш-таблица? Какие коллизии могут возникнуть и как их разрешать?',
            "Xesh-jadval nima? Qanday kolliziyalar yuzaga kelishi mumkin va ularni qanday hal qilish mumkin?",
          ),
          points: 5,
          time: 180,
          difficulty: 'hard',
          payload: {
            rubric: t(
              'Хеш-функция, бакеты, методы разрешения коллизий: цепочки или открытая адресация.',
              "Xesh-funksiya, bucket'lar, kolliziyalarni hal qilish usullari: zanjirlar yoki ochiq adreslash.",
            ),
          },
        },
      ],
    },
  ];
}
