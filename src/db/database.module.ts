import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './schema';

export const KYSELY = Symbol('KYSELY');
export type Database = Kysely<DB>;

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ConfigService],
      useFactory: (): Kysely<DB> => {
        const pool = new Pool({
          host: '116.202.26.85',
          port: 5444,
          user: 'postgres',
          password:
            'ShhnwfTp3KP0e3dHyCPNGLJ15vM4ol08YZ4El9449olA5RUdLOvrvTQRGay2JL3e',
          database: 'ticketer',
					ssl: false,
          max: 10,
        });
        return new Kysely<DB>({
          dialect: new PostgresDialect({ pool }),
          plugins: [new CamelCasePlugin()],
        });
      },
    },
  ],
  exports: [KYSELY],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor() {}
  async onModuleDestroy() {
    // Pool is cleaned up when Kysely instance is GC'd; explicit destroy handled at app shutdown
  }
}
