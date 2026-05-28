import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import { KYSELY, type Database } from '../../db/database.module';

export const SESSION_TOKEN_COOKIE = 'ticketer_session';
export const SESSION_TOKEN_HEADER = 'x-session-token';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

@Injectable()
export class SessionTokenGuard implements CanActivate {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const sessionId: string | undefined = req.params?.id ?? req.params?.sessionId;
    if (!sessionId) throw new UnauthorizedException('Missing session id');

    const token: string | undefined =
      req.cookies?.[SESSION_TOKEN_COOKIE] ??
      req.headers?.[SESSION_TOKEN_HEADER] ??
      (req.query?.sessionToken as string | undefined);
    if (!token) throw new UnauthorizedException('Missing session token');

    const member = await this.db
      .selectFrom('roomMembers')
      .selectAll()
      .where('sessionId', '=', sessionId)
      .where('sessionTokenHash', '=', hashToken(token))
      .executeTakeFirst();
    if (!member) throw new UnauthorizedException('Invalid session token');

    req.member = member;
    return true;
  }
}
