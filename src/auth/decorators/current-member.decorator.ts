import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RoomMembers } from '../../db/schema';

export type RoomMember = {
  [K in keyof RoomMembers]: RoomMembers[K] extends { __select__: infer S } ? S : RoomMembers[K];
};

export const CurrentMember = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    return ctx.switchToHttp().getRequest().member;
  },
);
