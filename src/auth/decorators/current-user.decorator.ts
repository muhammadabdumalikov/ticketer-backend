import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { PublicUser } from '../../users/users.service';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PublicUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);
