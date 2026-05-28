import { Inject, Injectable } from '@nestjs/common';
import { KYSELY, type Database } from '../db/database.module';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: string;
  department: string | null;
}

@Injectable()
export class UsersService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async findByEmail(email: string) {
    return this.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();
  }

  async findById(id: string): Promise<PublicUser | undefined> {
    return this.db
      .selectFrom('users')
      .select(['id', 'email', 'name', 'role', 'department'])
      .where('id', '=', id)
      .executeTakeFirst();
  }
}
