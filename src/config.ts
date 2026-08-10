import { z } from 'zod';

const configSchema = z.object({
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  META_APP_SECRET: z.string().min(16),
  META_VERIFY_TOKEN: z.string().min(16),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

const settingOrder = ['HOST', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'PORT'] as const;

export interface AppConfig {
  readonly host: string;
  readonly metaAppSecret: string;
  readonly metaVerifyToken: string;
  readonly port: number;
}

export function loadConfig(environment: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = configSchema.safeParse(environment);

  if (!result.success) {
    const invalidSettings = new Set(
      result.error.issues
        .map((issue) => issue.path[0])
        .filter((path): path is string => typeof path === 'string'),
    );
    const names = settingOrder.filter((name) => invalidSettings.has(name));
    throw new Error(`Invalid configuration: ${names.join(', ')}`);
  }

  return {
    host: result.data.HOST,
    metaAppSecret: result.data.META_APP_SECRET,
    metaVerifyToken: result.data.META_VERIFY_TOKEN,
    port: result.data.PORT,
  };
}
