export interface AppConfig {
  port: number;
  corsOrigin: string;
  databaseUrl: string;
  jwt: {
    secret: string;
    expiresIn: string;
  };
}

export default (): AppConfig => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://ticketer:ticketer@localhost:5432/ticketer',
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-secret-do-not-use-in-prod',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },
});
