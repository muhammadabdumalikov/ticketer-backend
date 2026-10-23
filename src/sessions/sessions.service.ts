import {
  BadRequestException,
  ConflictException,
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

/** Extra time after the exam's duration during which in-flight answers are still accepted. */
const SUBMIT_GRACE_MS = 2 * 60 * 1000;

/** Trim and collapse inner whitespace so "Ali  Valiyev " and "Ali Valiyev" are one student. */
function normalizeIdentity(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Text answers match ignoring case and whitespace differences. */
function sameText(a: string, b: string): boolean {
  return normalizeIdentity(a).toLowerCase() === normalizeIdentity(b).toLowerCase();
}

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

  /**
   * The ticket currently assigned to one room member — read fresh so the
   * proctor always grades the student's actual билет, never the session default.
   */
  async getAssignedTicketId(teacherId: string, sessionId: string, memberId: string) {
    await this.requireOwned(teacherId, sessionId);
    const member = await this.db
      .selectFrom('roomMembers')
      .select(['assignedTicketId'])
      .where('id', '=', memberId)
      .where('sessionId', '=', sessionId)
      .executeTakeFirst();
    if (!member) throw new NotFoundException('Member not found');
    return { assignedTicketId: member.assignedTicketId };
  }

  async start(teacherId: string, id: string) {
    const session = await this.requireOwned(teacherId, id);
    if (session.status === 'live') return session;
    if (session.status === 'finished') throw new BadRequestException('Session already finished');

    const { updated, members } = await this.db.transaction().execute(async (trx) => {
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
      return { updated, members };
    });

    // A student who joined while the transaction above was running saw the
    // session as still scheduled and was not in `unassigned` — hand them a
    // ticket now that the session is visibly live.
    for (const m of members) {
      if (!m.assignedTicketId) m.assignedTicketId = await this.assignTicketIfNeeded(id, m.id);
    }

    // Broadcast only after commit: students react by fetching `/me`, which must
    // already see their assigned ticket. Who got which ticket is proctor-only.
    this.gateway.toStudents(id, 'session:start', { sessionId: id, startedAt: updated.startedAt });
    this.gateway.toStaff(id, 'session:start', {
      sessionId: id,
      startedAt: updated.startedAt,
      assignments: members.map((m) => ({ memberId: m.id, ticketId: m.assignedTicketId })),
    });
    return updated;
  }

  async end(teacherId: string, id: string) {
    const session = await this.requireOwned(teacherId, id);
    if (session.status === 'finished') return session;

    const { updated, autoGradedCount } = await this.db.transaction().execute(async (trx) => {
      // 1) Auto-grade MCQ answers (single/multi) that haven't been graded yet.
      const ungraded = await trx
        .selectFrom('answers as a')
        .innerJoin('questions as q', 'q.id', 'a.questionId')
        .select([
          'a.id as answerId',
          'a.selectedIndex',
          'a.selectedIndices',
          'a.textValue',
          'a.numericValue',
          'q.id as questionId',
          'q.type',
          'q.points',
          'q.payload',
        ])
        .where('a.sessionId', '=', id)
        .where('a.pointsAwarded', 'is', null)
        .where('q.type', 'in', ['single', 'multi', 'text', 'numeric'])
        .execute();

      let autoGradedCount = 0;
      for (const row of ungraded) {
        const payload = (row.payload ?? {}) as {
          correct?: number | number[];
          expected?: string | number | null;
          tolerance?: number;
        };
        // Without a reference answer a text/numeric question is left for manual grading.
        const expected = payload.expected;
        if (row.type === 'text' && (typeof expected !== 'string' || expected.trim() === '')) continue;
        if (row.type === 'numeric' && typeof expected !== 'number') continue;

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
        } else if (row.type === 'text' && typeof expected === 'string') {
          if (row.textValue != null && sameText(row.textValue, expected)) award = row.points;
        } else if (row.type === 'numeric' && typeof expected === 'number') {
          const tolerance = Math.abs(payload.tolerance ?? 0);
          // epsilon absorbs float noise, e.g. 0.1 + 0.2 vs 0.3
          if (row.numericValue != null && Math.abs(row.numericValue - expected) <= tolerance + 1e-9) {
            award = row.points;
          }
        }
        autoGradedCount++;
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
      return { updated, autoGradedCount };
    });

    this.gateway.broadcast(id, 'session:end', {
      sessionId: id,
      endedAt: updated.endedAt,
      autoGradedCount,
    });
    return updated;
  }

  // ─────────── Student ───────────

  async join(sessionId: string, dto: JoinSessionDto) {
    const session = await this.db
      .selectFrom('sessions')
      .select(['id', 'status', 'examId', 'ticketsPolicy'])
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!session) {
      throw new NotFoundException({ code: 'session_not_found', message: 'Session not found' });
    }
    if (session.status === 'finished') {
      throw new BadRequestException({ code: 'session_finished', message: 'Session is finished' });
    }

    const name = normalizeIdentity(dto.name);
    const group = normalizeIdentity(dto.group);
    const studentNumber = dto.studentNumber ? normalizeIdentity(dto.studentNumber) : null;

    // Reconnect: same (name, group) — ignoring case and spacing — returns the
    // same member with a fresh token.
    const existing = await this.db
      .selectFrom('roomMembers')
      .select(['id', 'studentNumber'])
      .where('sessionId', '=', sessionId)
      .where(sql<string>`lower(name)`, '=', name.toLowerCase())
      .where(sql<string>`lower(group_name)`, '=', group.toLowerCase())
      .executeTakeFirst();

    if (existing) {
      // Two different students with the same name in one group.
      if (existing.studentNumber && studentNumber && existing.studentNumber !== studentNumber) {
        throw new ConflictException({
          code: 'identity_mismatch',
          message: 'Another student with this name has already joined this group',
        });
      }
      // Taking over a seat that is live elsewhere would silently kick that
      // student out — refuse; once the other tab closes or drops (≈1 min), it's free.
      if (await this.gateway.isMemberConnected(existing.id)) {
        throw new ConflictException({
          code: 'seat_in_use',
          message: 'This student is already connected from another tab or device',
        });
      }
    }

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
          studentNumber: studentNumber ?? existing.studentNumber,
        })
        .where('id', '=', existing.id)
        .execute();
    } else {
      const row = await this.db
        .insertInto('roomMembers')
        .values({
          sessionId,
          name,
          groupName: group,
          studentNumber,
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
    if (session.status === 'live') await this.assignTicketIfNeeded(sessionId, memberId);
    const member = await this.db
      .selectFrom('roomMembers')
      .selectAll()
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow();

    this.gateway.broadcast(sessionId, 'session:join', {
      sessionId,
      member: {
        id: member.id,
        name: member.name,
        groupName: member.groupName,
        studentNumber: member.studentNumber ?? null,
        assignedTicketId: member.assignedTicketId ?? null,
        online: true,
        joinedAt: member.joinedAt,
      },
    });

    return { sessionToken: token, member };
  }

  async getMe(sessionId: string, memberId: string) {
    const session = await this.db
      .selectFrom('sessions')
      .select(['status', 'startedAt', 'endedAt'])
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    // Self-heal: a live session never leaves a student without a ticket, even
    // if they slipped past the assignment in `start()`.
    if (session.status === 'live') await this.assignTicketIfNeeded(sessionId, memberId);

    const member = await this.db
      .selectFrom('roomMembers')
      .selectAll()
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow();

    let assignedTicket: any = null;
    let ticketQuestions: Array<{ id: string; type: string; points: number }> = [];
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
      ticketQuestions = questions.map((q) => ({ id: q.id, type: q.type, points: q.points }));
      assignedTicket = {
        id: ticket.id,
        title: ticket.title,
        durationMin: ticket.durationMin,
        questions: questions.map((q) => this.studentSafeQuestion(q)),
        totalQuestions: questions.length,
      };
    }

    // The student's saved answers + verbal timing, so a reloaded or reconnected
    // page can restore its state. Grades and notes stay teacher-only.
    const answers = await this.db
      .selectFrom('answers')
      .select([
        'questionId',
        'selectedIndex',
        'selectedIndices',
        'textValue',
        'numericValue',
        'startedAt',
        'endedAt',
        'durationSec',
      ])
      .where('sessionId', '=', sessionId)
      .where('roomMemberId', '=', memberId)
      .execute();

    // Points are shown to the student only once the exam is over.
    let result: { earned: number; max: number; pending: number; total: number } | null = null;
    if (session.status === 'finished' && ticketQuestions.length > 0) {
      const graded = await this.db
        .selectFrom('answers')
        .select(['questionId', 'pointsAwarded'])
        .where('sessionId', '=', sessionId)
        .where('roomMemberId', '=', memberId)
        .execute();
      const byQuestion = new Map(graded.map((g) => [g.questionId, g.pointsAwarded]));
      let earned = 0;
      let max = 0;
      let pending = 0;
      for (const q of ticketQuestions) {
        max += q.points;
        const awarded = byQuestion.get(q.id);
        if (awarded != null) earned += awarded;
        // Still waiting for the teacher: verbal answers, and written answers that
        // have no reference answer to check against. An unanswered auto-checked
        // question has no row and simply scores 0.
        else if (q.type === 'verbal' || byQuestion.has(q.id)) pending += 1;
      }
      result = { earned, max, pending, total: ticketQuestions.length };
    }

    return { member, assignedTicket, sessionId, session, answers, result };
  }

  async submitAnswers(sessionId: string, memberId: string, dto: SubmitAnswersDto) {
    const ctx = await this.db
      .selectFrom('roomMembers as m')
      .innerJoin('sessions as s', 's.id', 'm.sessionId')
      .innerJoin('exams as e', 'e.id', 's.examId')
      .select(['m.assignedTicketId', 's.status', 's.startedAt', 'e.durationMin'])
      .where('m.id', '=', memberId)
      .where('m.sessionId', '=', sessionId)
      .executeTakeFirstOrThrow();

    // `exam_closed`: the session is over, the client leaves. `time_over`: written
    // answers are closed, but the student may still be waiting for a verbal turn.
    if (ctx.status !== 'live' || !ctx.startedAt) {
      throw new BadRequestException({ code: 'exam_closed', message: 'Session is not live' });
    }
    const deadline = new Date(ctx.startedAt).getTime() + ctx.durationMin * 60_000 + SUBMIT_GRACE_MS;
    if (Date.now() > deadline) {
      throw new BadRequestException({ code: 'time_over', message: 'Exam time is over' });
    }

    // Only auto-checked questions of the student's own ticket; verbal answers
    // are recorded by the proctor.
    const allowed = ctx.assignedTicketId
      ? await this.db
          .selectFrom('questions')
          .select(['id'])
          .where('ticketId', '=', ctx.assignedTicketId)
          .where('type', '!=', 'verbal')
          .execute()
      : [];
    const allowedIds = new Set(allowed.map((q) => q.id));
    const foreign = dto.answers.find((a) => !allowedIds.has(a.questionId));
    if (foreign) throw new BadRequestException(`Question ${foreign.questionId} is not on your ticket`);

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
    this.gateway.toMember(sessionId, dto.memberId, 'verbal:status', {
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
    this.gateway.toMember(sessionId, dto.memberId, 'verbal:status', {
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
    // Grades go to the proctor only — never to the students in the room.
    this.gateway.toStaff(sessionId, 'grade:save', {
      sessionId,
      memberId: dto.memberId,
      questionId: dto.questionId,
      pointsAwarded: dto.pointsAwarded,
    });
  }

  // ─────────── Helpers ───────────

  /**
   * Give a member of a live session a random ticket if they have none yet.
   * Prefers an unused ticket under `one-per-student` while fresh билеты remain,
   * otherwise picks from the full pool (`allow-duplicates`, or students > tickets).
   * Returns the member's ticket id (existing or new), or null if the pool is empty.
   */
  private async assignTicketIfNeeded(sessionId: string, memberId: string): Promise<string | null> {
    const member = await this.db
      .selectFrom('roomMembers as m')
      .innerJoin('sessions as s', 's.id', 'm.sessionId')
      .select(['m.assignedTicketId', 's.examId', 's.ticketsPolicy'])
      .where('m.id', '=', memberId)
      .where('m.sessionId', '=', sessionId)
      .executeTakeFirst();
    if (!member) return null;
    if (member.assignedTicketId) return member.assignedTicketId;

    const pool = await this.db
      .selectFrom('tickets')
      .select(['id'])
      .where('examId', '=', member.examId)
      .orderBy('position')
      .execute();
    if (pool.length === 0) return null;

    let candidatePool = pool;
    if (member.ticketsPolicy === 'one-per-student') {
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
    // Guard on `is null` so two concurrent calls can't overwrite each other.
    await this.db
      .updateTable('roomMembers')
      .set({ assignedTicketId: ticketId })
      .where('id', '=', memberId)
      .where('assignedTicketId', 'is', null)
      .execute();
    const row = await this.db
      .selectFrom('roomMembers')
      .select(['assignedTicketId'])
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow();
    return row.assignedTicketId;
  }

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
    const fields = {
      selectedIndex: a.selectedIndex ?? null,
      selectedIndices: a.selectedIndices ? JSON.stringify(a.selectedIndices) : null,
      textValue: a.textValue ?? null,
      numericValue: a.numericValue ?? null,
      updatedAt: new Date(),
    };
    // Single statement, so two concurrent saves of one answer can't collide on
    // the (session, member, question) unique constraint.
    await this.db
      .insertInto('answers')
      .values({ sessionId, roomMemberId: memberId, questionId: a.questionId, ...(fields as any) })
      .onConflict((oc) =>
        oc.columns(['sessionId', 'roomMemberId', 'questionId']).doUpdateSet(fields as any),
      )
      .execute();
  }

  private async ensureAnswerRow(sessionId: string, memberId: string, questionId: string) {
    await this.db
      .insertInto('answers')
      .values({ sessionId, roomMemberId: memberId, questionId } as any)
      .onConflict((oc) => oc.columns(['sessionId', 'roomMemberId', 'questionId']).doNothing())
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
