import { ConfigService } from '@nestjs/config';
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { KYSELY, type Database } from '../db/database.module';
import { hashToken } from '../auth/guards/session-token.guard';
import type { JwtPayload } from '../auth/auth.service';

export type SessionEvent =
  | 'session:join'
  | 'session:start'
  | 'session:tick'
  | 'verbal:status'
  | 'grade:save'
  | 'member:presence'
  | 'session:end';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SocketAuth {
  teacherId?: string;
  memberId?: string;
  sessionId?: string;
}

@Injectable()
@WebSocketGateway({
  namespace: '/sessions',
  cors: { origin: true, credentials: true },
})
export class SessionsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SessionsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const bearer = client.handshake.auth?.token ?? this.extractBearer(client);
      const sessionToken =
        client.handshake.auth?.sessionToken ??
        (client.handshake.query?.sessionToken as string | undefined);
      const sessionId = (client.handshake.query?.sessionId as string | undefined) ?? '';

      const auth: SocketAuth = {};

      // Rooms are joined here, during the handshake, rather than by the
      // client's `join` emit — that emit can race ahead of this async check.
      if (bearer) {
        const payload = await this.jwt.verifyAsync<JwtPayload>(bearer, {
          secret: this.config.get<string>('jwt.secret'),
        });
        auth.teacherId = payload.sub;
        client.data.auth = auth;
        if (sessionId && (await this.teacherOwns(payload.sub, sessionId))) {
          client.join(this.staffRoomFor(sessionId));
        }
      } else if (sessionToken && sessionId) {
        const member = await this.db
          .selectFrom('roomMembers')
          .select(['id', 'sessionId'])
          .where('sessionId', '=', sessionId)
          .where('sessionTokenHash', '=', hashToken(sessionToken))
          .executeTakeFirst();
        if (!member) throw new UnauthorizedException('Invalid session token');
        auth.memberId = member.id;
        auth.sessionId = sessionId;
        client.data.auth = auth;
        client.join([this.roomFor(sessionId), this.memberRoomFor(member.id)]);
        await this.setPresence(sessionId, member.id, true);
      } else {
        throw new UnauthorizedException('Missing credentials');
      }

      this.logger.log(`Socket connected: ${client.id} (${auth.teacherId ? 'teacher' : 'student'})`);
    } catch (err) {
      this.logger.warn(`Socket auth failed: ${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    this.logger.log(`Socket disconnected: ${client.id}`);
    const auth = client.data.auth as SocketAuth | undefined;
    if (!auth?.memberId || !auth.sessionId) return;
    try {
      // The same student may still be connected from another tab or device.
      const sockets = await this.server.in(this.roomFor(auth.sessionId)).fetchSockets();
      const stillHere = sockets.some(
        (s) => s.id !== client.id && (s.data.auth as SocketAuth | undefined)?.memberId === auth.memberId,
      );
      if (!stillHere) await this.setPresence(auth.sessionId, auth.memberId, false);
    } catch (err) {
      this.logger.warn(`Presence update failed: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('join')
  async onJoin(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId: string }) {
    if (!body?.sessionId) return { ok: false, error: 'sessionId required' };
    const auth = client.data.auth as SocketAuth | undefined;
    if (!auth) return { ok: false, error: 'not authenticated' };
    // Students are placed in their own session's room during the handshake.
    if (auth.memberId) return { ok: auth.sessionId === body.sessionId };
    if (!auth.teacherId || !(await this.teacherOwns(auth.teacherId, body.sessionId))) {
      return { ok: false, error: 'forbidden' };
    }
    client.join(this.staffRoomFor(body.sessionId));
    return { ok: true };
  }

  /** Every student in the session and its proctor. */
  broadcast(sessionId: string, event: SessionEvent, payload: unknown): void {
    this.server.to([this.roomFor(sessionId), this.staffRoomFor(sessionId)]).emit(event, payload);
  }

  toStudents(sessionId: string, event: SessionEvent, payload: unknown): void {
    this.server.to(this.roomFor(sessionId)).emit(event, payload);
  }

  toStaff(sessionId: string, event: SessionEvent, payload: unknown): void {
    this.server.to(this.staffRoomFor(sessionId)).emit(event, payload);
  }

  /** One student (all their tabs/devices) and the proctor. */
  toMember(sessionId: string, memberId: string, event: SessionEvent, payload: unknown): void {
    this.server.to([this.memberRoomFor(memberId), this.staffRoomFor(sessionId)]).emit(event, payload);
  }

  async isMemberConnected(memberId: string): Promise<boolean> {
    const sockets = await this.server.in(this.memberRoomFor(memberId)).fetchSockets();
    return sockets.length > 0;
  }

  private async setPresence(sessionId: string, memberId: string, online: boolean): Promise<void> {
    await this.db
      .updateTable('roomMembers')
      .set({ online, lastSeenAt: new Date() })
      .where('id', '=', memberId)
      .execute();
    this.toStaff(sessionId, 'member:presence', { sessionId, memberId, online });
  }

  private async teacherOwns(teacherId: string, sessionId: string): Promise<boolean> {
    // Postgres rejects malformed uuids with an error rather than "no rows".
    if (!UUID_RE.test(sessionId)) return false;
    const row = await this.db
      .selectFrom('sessions')
      .select(['id'])
      .where('id', '=', sessionId)
      .where('teacherId', '=', teacherId)
      .executeTakeFirst();
    return !!row;
  }

  // Students and the proctor sit in separate rooms so teacher-only events
  // (grades, presence, ticket assignments) never reach students' browsers.
  private roomFor(sessionId: string): string {
    return `session:${sessionId}`;
  }

  private staffRoomFor(sessionId: string): string {
    return `session:${sessionId}:staff`;
  }

  private memberRoomFor(memberId: string): string {
    return `member:${memberId}`;
  }

  private extractBearer(client: Socket): string | undefined {
    const raw = client.handshake.headers?.authorization;
    if (!raw) return undefined;
    const [scheme, token] = raw.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? token : undefined;
  }
}
