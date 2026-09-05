export type SafeLogEvent =
  | 'admin_request_failed'
  | 'admin_request_rejected'
  | 'admin_service_start_failed'
  | 'admin_service_started'
  | 'database_pool_error'
  | 'meta_verification_accepted'
  | 'meta_verification_rejected'
  | 'meta_webhook_accepted'
  | 'meta_webhook_rejected'
  | 'service_start_failed'
  | 'service_started';

export type SafeLogReason =
  | 'csrf_denied'
  | 'invalid_origin'
  | 'invalid_body'
  | 'invalid_json'
  | 'invalid_signature'
  | 'invalid_verification'
  | 'receipt_unavailable';

export interface SafeLogContext {
  readonly channel?: 'messenger' | 'unknown' | 'whatsapp';
  readonly eventCount?: number;
  readonly reason?: SafeLogReason;
  readonly requestId?: string;
  readonly statusCode?: number;
}

export interface SafeLogger {
  readonly error: (event: SafeLogEvent, context?: SafeLogContext) => void;
  readonly info: (event: SafeLogEvent, context?: SafeLogContext) => void;
  readonly warn: (event: SafeLogEvent, context?: SafeLogContext) => void;
}

interface CreateSafeLoggerOptions {
  readonly now?: () => Date;
  readonly write?: (line: string) => void;
}

type LogLevel = 'error' | 'info' | 'warn';

const safeEvents = new Set<SafeLogEvent>([
  'admin_request_failed',
  'admin_request_rejected',
  'admin_service_start_failed',
  'admin_service_started',
  'database_pool_error',
  'meta_verification_accepted',
  'meta_verification_rejected',
  'meta_webhook_accepted',
  'meta_webhook_rejected',
  'service_start_failed',
  'service_started',
]);

const safeReasons = new Set<SafeLogReason>([
  'csrf_denied',
  'invalid_origin',
  'invalid_body',
  'invalid_json',
  'invalid_signature',
  'invalid_verification',
  'receipt_unavailable',
]);

const safeChannels = new Set<NonNullable<SafeLogContext['channel']>>([
  'messenger',
  'unknown',
  'whatsapp',
]);

export function createSafeLogger(options: CreateSafeLoggerOptions = {}): SafeLogger {
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });

  function log(level: LogLevel, event: SafeLogEvent, context: SafeLogContext = {}): void {
    const record: Record<string, unknown> = {
      timestamp: now().toISOString(),
      level,
      event: safeEvents.has(event) ? event : 'invalid_log_event',
    };

    if (typeof context.requestId === 'string') {
      record.requestId = context.requestId;
    }
    if (Number.isInteger(context.statusCode)) {
      record.statusCode = context.statusCode;
    }
    if (Number.isInteger(context.eventCount) && (context.eventCount ?? -1) >= 0) {
      record.eventCount = context.eventCount;
    }
    if (context.channel !== undefined && safeChannels.has(context.channel)) {
      record.channel = context.channel;
    }
    if (context.reason !== undefined && safeReasons.has(context.reason)) {
      record.reason = context.reason;
    }

    try {
      write(JSON.stringify(record));
    } catch {
      // Logging failures must not alter webhook admission outcomes.
    }
  }

  return {
    error: (event, context) => {
      log('error', event, context);
    },
    info: (event, context) => {
      log('info', event, context);
    },
    warn: (event, context) => {
      log('warn', event, context);
    },
  };
}

export const noopSafeLogger: SafeLogger = Object.freeze({
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
});
