import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { KYSELY, type Database } from '../db/database.module';
import {
  generateToken,
  hashToken,
} from '../auth/guards/session-token.guard';
import { SessionsGateway } from './sessions.gateway';
import type {
  AnswerItemDto,
  CreateSessionDto,
  GradeDto,
  JoinSessionDto,
  SubmitAnswersDto,
  VerbalActionDto,
} from './dto/session.dto';

@Injectable()
export class SessionsService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly gateway: SessionsGateway,
  ) {}

  // ─────────── Teacher ───────────

  /**
   * Sessions owned by the teacher that haven't finished yet (live + scheduled).
   * Live first, then by scheduledAt asc (nulls last), then most recently created.
   */
  async listUpcoming(teacherId: string) {
    const rows = await this.db
      .selectFrom('sessions as se')
      .innerJoin('exams as e', 'e.id', 'se.examId')
      .innerJoin('subjects as su', 'su.id', 'e.subjectId')
      .select([
        'se.id',
        'se.status',
        'se.scheduledAt',
        'se.startedAt',
        'se.createdAt',
        'e.id as examId',
        'e.title as ticketTitle',
        'e.durationMin',
        'su.code as subjectCode',
        'su.name as subjectName',
        sql<number>`(
          select coalesce(sum(qc.cnt), 0)::int from (
            select count(*) as cnt
              from questions q
              join tickets t on t.id = q.ticket_id
             where t.exam_id = e.id
             group by q.ticket_id
          ) qc
        )`.as('questionCount'),
        sql<number>`(select count(*) from room_members m where m.session_id = se.id)::int`.as(
          'memberCount',
        ),
      ])
      .where('se.teacherId', '=', teacherId)
      .where('se.status', '!=', 'finished')
      .orderBy(sql`case when se.status = 'live' then 0 else 1 end`)
      .orderBy(sql`se.scheduled_at asc nulls last`)
      .orderBy('se.createdAt', 'desc')
      .limit(20)
      .execute();
    return rows;
  }

  async create(teacherId: string, dto: CreateSessionDto) {
    const exam = await this.db
      .selectFrom('exams')
      .select(['id', 'authorId'])
      .where('id', '=', dto.examId)
      .executeTakeFirst();
    if (!exam) throw new NotFoundException('Exam not found');
    if (exam.authorId !== teacherId) throw new ForbiddenException();

    // Pick the exam's first ticket as the default session ticket. The
    // teacher can swap per-member later when multi-ticket exams arrive.
    const firstTicket = await this.db
      .selectFrom('tickets')
      .select(['id'])
      .where('examId', '=', dto.examId)
      .orderBy('position')
      .limit(1)
      .executeTakeFirst();
    if (!firstTicket) throw new BadRequestException('Exam has no tickets yet');

    return this.db
      .insertInto('sessions')
      .values({
        examId: dto.examId,
        ticketId: firstTicket.id,
        teacherId,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        ticketsPolicy: dto.ticketsPolicy ?? 'one-per-student',
        status: 'scheduled',
      } as any)
      .returning(['id', 'status', 'scheduledAt'])
      .executeTakeFirstOrThrow();
  }

  async getOne(teacherId: string, id: string) {
    const session = await this.requireOwned(teacherId, id);
    const ticket = await this.db
      .selectFrom('tickets as t')
      .innerJoin('exams as e', 'e.id', 't.examId')
      .innerJoin('subjects as s', 's.id', 't.subjectId')
      .select(['t.id', 't.title', 'e.durationMin', 's.name as subjectName', 's.code as subjectCode'])
      .where('t.id', '=', session.ticketId)
      .executeTakeFirstOrThrow();
    return { ...session, ticket };
  }

  async getRoster(teacherId: string, id: string) {
    await this.requireOwned(teacherId, id);
    return this.db
      .selectFrom('roomMembers')
      .select(['id', 'name', 'groupName', 'studentNumber', 'online', 'assignedTicketId', 'joinedAt'])
      .where('sessionId', '=', id)
      .orderBy('joinedAt')
      .execute();
  }

  async start(teacherId: string, id: string) {
    const session = await this.requireOwned(teacherId, id);
    if (session.status === 'live') return session;
    if (session.status === 'finished') throw new BadRequestException('Session already finished');

    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('sessions')
        .set({ status: 'live', startedAt: new Date(), updatedAt: new Date() })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      // Pull the exam's ticket pool so we can hand each student a random билет.
      const pool = await trx
        .selectFrom('tickets')
        .select(['id'])
        .where('examId', '=', session.examId)
        .orderBy('position')
        .execute();
      if (pool.length === 0) throw new BadRequestException('Exam has no tickets');

      // Members currently in the room without a ticket yet — these need assignment.
      const unassigned = await trx
        .selectFrom('roomMembers')
        .select(['id'])
        .where('sessionId', '=', id)
        .where('assignedTicketId', 'is', null)
        .execute();

      // Fisher–Yates shuffle of the pool. With `one-per-student` policy and
      // enough billets we walk the shuffled list (everyone unique); otherwise
      // we fall back to random-with-replacement.
      const shuffled = pool.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const uniquePolicy =
        session.ticketsPolicy === 'one-per-student' && unassigned.length <= shuffled.length;

      for (let i = 0; i < unassigned.length; i++) {
        const ticketId = uniquePolicy
          ? shuffled[i].id
          : shuffled[Math.floor(Math.random() * shuffled.length)].id;
        await trx
          .updateTable('roomMembers')
          .set({ assignedTicketId: ticketId })
          .where('id', '=', unassigned[i].id)
          .execute();
      }

      const members = await trx
        .selectFrom('roomMembers')
        .select(['id', 'assignedTicketId'])
        .where('sessionId', '=', id)
        .execute();

      this.gateway.broadcast(id, 'session:start', {
        sessionId: id,
        startedAt: updated.startedAt,
        assignments: members.map((m) => ({ memberId: m.id, ticketId: m.assignedTicketId })),
      });
      return updated;
    });
  }

  async end(teacherId: string, id: string) {
    const session = await this.requireOwned(teacherId, id);
    if (session.status === 'finished') return session;

    return this.db.transaction().execute(async (trx) => {
      // 1) Auto-grade MCQ answers (single/multi) that haven't been graded yet.
      const ungraded = await trx
        .selectFrom('answers as a')
        .innerJoin('questions as q', 'q.id', 'a.questionId')
        .select([
          'a.id as answerId',
          'a.selectedIndex',
          'a.selectedIndices',
          'q.id as questionId',
          'q.type',
          'q.points',
          'q.payload',
        ])
        .where('a.sessionId', '=', id)
        .where('a.pointsAwarded', 'is', null)
        .where('q.type', 'in', ['single', 'multi'])
        .execute();

      for (const row of ungraded) {
        const payload = (row.payload ?? {}) as {
          correct?: number | number[];
        };
        let award = 0;
        if (row.type === 'single' && typeof payload.correct === 'number') {
          if (row.selectedIndex != null && row.selectedIndex === payload.correct) {
            award = row.points;
          }
        } else if (row.type === 'multi' && Array.isArray(payload.correct)) {
          const got = Array.isArray(row.selectedIndices)
            ? (row.selectedIndices as number[])
            : [];
          const correct = payload.correct as number[];
          const sameLength = got.length === correct.length;
          const sameMembers = correct.every((c) => got.includes(c));
          if (sameLength && sameMembers) award = row.points;
        }
        await trx
          .updateTable('answers')
          .set({
            pointsAwarded: award,
            gradedBy: teacherId,
            gradedAt: new Date(),
            updatedAt: new Date(),
          })
          .where('id', '=', row.answerId)
          .execute();
      }

      // 2) Mark session finished.
      const updated = await trx
        .updateTable('sessions')
        .set({ status: 'finished', endedAt: new Date(), updatedAt: new Date() })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      this.gateway.broadcast(id, 'session:end', {
        sessionId: id,
        endedAt: updated.endedAt,
        autoGradedCount: ungraded.length,
      });
      return updated;
    });
  }

  // ─────────── Student ───────────

  async join(sessionId: string, dto: JoinSessionDto) {
    const session = await this.db
      .selectFrom('sessions')
      .select(['id', 'status', 'examId', 'ticketsPolicy'])
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!session) throw new NotFoundException('Session not found');
    if (session.status === 'finished') throw new BadRequestException('Session is finished');

    // Reconnect: same (name, group) returns the same member with a fresh token.
    const existing = await this.db
      .selectFrom('roomMembers')
      .select(['id'])
      .where('sessionId', '=', sessionId)
      .where('name', '=', dto.name)
      .where('groupName', '=', dto.group)
      .executeTakeFirst();

    const token = generateToken();
    const tokenHash = hashToken(token);

    let memberId: string;
    if (existing) {
      memberId = existing.id;
      await this.db
        .updateTable('roomMembers')
        .set({
          sessionTokenHash: tokenHash,
          online: true,
          lastSeenAt: new Date(),
          studentNumber: dto.studentNumber ?? null,
        })
        .where('id', '=', existing.id)
        .execute();
    } else {
      const row = await this.db
        .insertInto('roomMembers')
        .values({
          sessionId,
          name: dto.name,
          groupName: dto.group,
          studentNumber: dto.studentNumber ?? null,
          online: true,
          sessionTokenHash: tokenHash,
        } as any)
        .returning(['id'])
        .executeTakeFirstOrThrow();
      memberId = row.id;
    }

    // If the session is already live (i.e. the teacher already clicked
    // Запустить before this student joined), assign them a random ticket
    // right now so `getMe` returns it and the student lands on Ticket view.
    let member = await this.db
      .selectFrom('roomMembers')
      .selectAll()
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow();

    if (session.status === 'live' && !member.assignedTicketId) {
      const pool = await this.db
        .selectFrom('tickets')
        .select(['id'])
        .where('examId', '=', session.examId)
        .orderBy('position')
        .execute();
      if (pool.length > 0) {
        // Prefer an unused ticket when policy is one-per-student and there's
        // still a fresh билет available — otherwise fall back to random from
        // the full pool (covers `allow-duplicates` and the case where
        // students > tickets).
        let candidatePool = pool;
        if (session.ticketsPolicy === 'one-per-student') {
          const taken = await this.db
            .selectFrom('roomMembers')
            .select(['assignedTicketId'])
            .where('sessionId', '=', sessionId)
            .where('assignedTicketId', 'is not', null)
            .execute();
          const takenSet = new Set(taken.map((t) => t.assignedTicketId));
          const unused = pool.filter((t) => !takenSet.has(t.id));
          if (unused.length > 0) candidatePool = unused;
        }
        const ticketId = candidatePool[Math.floor(Math.random() * candidatePool.length)].id;
        await this.db
          .updateTable('roomMembers')
          .set({ assignedTicketId: ticketId })
          .where('id', '=', memberId)
          .execute();
        member = await this.db
          .selectFrom('roomMembers')
          .selectAll()
          .where('id', '=', memberId)
          .executeTakeFirstOrThrow();
      }
    }

    this.gateway.broadcast(sessionId, 'session:join', {
      sessionId,
      member: {
        id: member.id,
        name: member.name,
        groupName: member.groupName,
        online: true,
      },
    });

    return { sessionToken: token, member };
  }

  async getMe(sessionId: string, memberId: string) {
    const member = await this.db
      .selectFrom('roomMembers')
      .selectAll()
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow();

    let assignedTicket: any = null;
    if (member.assignedTicketId) {
      const ticket = await this.db
        .selectFrom('tickets as t')
        .innerJoin('exams as e', 'e.id', 't.examId')
        .select(['t.id', 't.title', 'e.durationMin'])
        .where('t.id', '=', member.assignedTicketId)
        .executeTakeFirstOrThrow();
      const questions = await this.db
        .selectFrom('questions')
        .selectAll()
        .where('ticketId', '=', ticket.id)
        .orderBy('position')
        .execute();
      assignedTicket = {
        id: ticket.id,
        title: ticket.title,
        durationMin: ticket.durationMin,
        questions: questions.map((q) => this.studentSafeQuestion(q)),
        totalQuestions: questions.length,
      };
    }

    return { member, assignedTicket, sessionId };
  }

  async submitAnswers(sessionId: string, memberId: string, dto: SubmitAnswersDto) {
    for (const a of dto.answers) {
      await this.upsertAnswer(sessionId, memberId, a);
    }
    return { ok: true };
  }

  // ─────────── Proctor (verbal grading) ───────────

  async verbalStart(teacherId: string, sessionId: string, dto: VerbalActionDto) {
    await this.requireOwned(teacherId, sessionId);
    await this.ensureAnswerRow(sessionId, dto.memberId, dto.questionId);
    await this.db
      .updateTable('answers')
      .set({ startedAt: new Date(), endedAt: null, durationSec: null, updatedAt: new Date() })
      .where('sessionId', '=', sessionId)
      .where('roomMemberId', '=', dto.memberId)
      .where('questionId', '=', dto.questionId)
      .execute();
    this.gateway.broadcast(sessionId, 'verbal:status', {
      sessionId,
      memberId: dto.memberId,
      questionId: dto.questionId,
      stage: 'recording',
    });
  }

  async verbalStop(teacherId: string, sessionId: string, dto: VerbalActionDto) {
    await this.requireOwned(teacherId, sessionId);
    const row = await this.db
      .selectFrom('answers')
      .select(['startedAt'])
      .where('sessionId', '=', sessionId)
      .where('roomMemberId', '=', dto.memberId)
      .where('questionId', '=', dto.questionId)
      .executeTakeFirst();
    const endedAt = new Date();
    const durationSec = row?.startedAt ? Math.round((endedAt.getTime() - new Date(row.startedAt).getTime()) / 1000) : 0;
    await this.db
      .updateTable('answers')
      .set({ endedAt, durationSec, updatedAt: new Date() })
      .where('sessionId', '=', sessionId)
      .where('roomMemberId', '=', dto.memberId)
      .where('questionId', '=', dto.questionId)
      .execute();
    this.gateway.broadcast(sessionId, 'verbal:status', {
      sessionId,
      memberId: dto.memberId,
      questionId: dto.questionId,
      stage: 'finished',
      durationSec,
    });
  }

  async grade(teacherId: string, sessionId: string, dto: GradeDto) {
    await this.requireOwned(teacherId, sessionId);
    await this.ensureAnswerRow(sessionId, dto.memberId, dto.questionId);
    await this.db
      .updateTable('answers')
      .set({
        pointsAwarded: dto.pointsAwarded,
        notes: dto.notes ?? null,
        gradedBy: teacherId,
        gradedAt: new Date(),
        updatedAt: new Date(),
      })
      .where('sessionId', '=', sessionId)
      .where('roomMemberId', '=', dto.memberId)
      .where('questionId', '=', dto.questionId)
      .execute();
    this.gateway.broadcast(sessionId, 'grade:save', {
      sessionId,
      memberId: dto.memberId,
      questionId: dto.questionId,
      pointsAwarded: dto.pointsAwarded,
    });
  }

  // ─────────── Helpers ───────────

  private async requireOwned(teacherId: string, sessionId: string) {
    const s = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!s) throw new NotFoundException('Session not found');
    if (s.teacherId !== teacherId) throw new ForbiddenException();
    return s;
  }

  private async upsertAnswer(sessionId: string, memberId: string, a: AnswerItemDto) {
    const existing = await this.db
      .selectFrom('answers')
      .select(['id'])
      .where('sessionId', '=', sessionId)
      .where('roomMemberId', '=', memberId)
      .where('questionId', '=', a.questionId)
      .executeTakeFirst();

    const fields = {
      selectedIndex: a.selectedIndex ?? null,
      selectedIndices: a.selectedIndices ? JSON.stringify(a.selectedIndices) : null,
      textValue: a.textValue ?? null,
      numericValue: a.numericValue ?? null,
      updatedAt: new Date(),
    };

    if (existing) {
      await this.db.updateTable('answers').set(fields as any).where('id', '=', existing.id).execute();
    } else {
      await this.db
        .insertInto('answers')
        .values({ sessionId, roomMemberId: memberId, questionId: a.questionId, ...(fields as any) })
        .execute();
    }
  }

  private async ensureAnswerRow(sessionId: string, memberId: string, questionId: string) {
    const row = await this.db
      .selectFrom('answers')
      .select(['id'])
      .where('sessionId', '=', sessionId)
      .where('roomMemberId', '=', memberId)
      .where('questionId', '=', questionId)
      .executeTakeFirst();
    if (row) return;
    await this.db
      .insertInto('answers')
      .values({ sessionId, roomMemberId: memberId, questionId } as any)
      .execute();
  }

  private studentSafeQuestion(q: any) {
    const payload = q.payload ?? {};
    // Strip teacher-only fields: rubric (verbal) and `correct` (MCQ) and `expected` (text/numeric)
    const { rubric: _r, correct: _c, expected: _e, tolerance: _t, ...safe } = payload;
    return {
      id: q.id,
      type: q.type,
      text: q.text,
      points: q.points,
      time: q.timeSec,
      position: q.position,
      ...safe,
    };
  }
}
