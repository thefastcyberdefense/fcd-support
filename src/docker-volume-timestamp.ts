import { z } from 'zod';

// Docker uses the daemon's timezone for volume CreatedAt. Keep its exact text
// as identity evidence, including an explicit offset and nanosecond precision.
export const dockerVolumeTimestampSchema = z.iso
  .datetime({ offset: true })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u);
