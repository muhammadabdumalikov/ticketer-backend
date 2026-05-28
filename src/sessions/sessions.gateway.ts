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
  | 'session:end';

interface SocketAuth {
  teacherId?: string;
  memberId?: string;
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

      if (bearer) {
        const payload = await this.jwt.verifyAsync<JwtPayload>(bearer, {
          secret: this.config.get<string>('jwt.secret'),
        });
        auth.teacherId = payload.sub;
      } else if (sessionToken && sessionId) {
        const member = await this.db
          .selectFrom('roomMembers')
          .select(['id', 'sessionId'])
          .where('sessionId', '=', sessionId)
          .where('sessionTokenHash', '=', hashToken(sessionToken))
          .executeTakeFirst();
        if (!member) throw new UnauthorizedException('Invalid session token');
        auth.memberId = member.id;
        client.join(this.roomFor(sessionId));
      } else {
        throw new UnauthorizedException('Missing credentials');
      }

      client.data.auth = auth;
      this.logger.log(`Socket connected: ${client.id} (${auth.teacherId ? 'teacher' : 'student'})`);
    } catch (err) {
      this.logger.warn(`Socket auth failed: ${(err as Error).message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Socket disconnected: ${client.id}`);
  }

  @SubscribeMessage('join')
  async onJoin(@ConnectedSocket() client: Socket, @MessageBody() body: { sessionId: string }) {
    if (!body?.sessionId) return { ok: false, error: 'sessionId required' };
    client.join(this.roomFor(body.sessionId));
    return { ok: true };
  }

  broadcast(sessionId: string, event: SessionEvent, payload: unknown): void {
    this.server.to(this.roomFor(sessionId)).emit(event, payload);
  }

  private roomFor(sessionId: string): string {
    return `session:${sessionId}`;
  }

  private extractBearer(client: Socket): string | undefined {
    const raw = client.handshake.headers?.authorization;
    if (!raw) return undefined;
    const [scheme, token] = raw.split(' ');
    return scheme?.toLowerCase() === 'bearer' ? token : undefined;
  }
}
