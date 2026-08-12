export interface ChannelIdentitySelector {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly externalContactId: string;
}

export type EventApplicationOutcome =
  | 'business_echo_ignored_before_resume'
  | 'business_echo_paused'
  | 'customer_message_applied'
  | 'message_status_ignored';

export type EventProcessResult =
  | {
      readonly status: 'applied';
      readonly eventId: string;
      readonly outcome: EventApplicationOutcome;
      readonly conversationId?: string;
    }
  | {
      readonly status: 'already_applied';
      readonly eventId: string;
      readonly outcome: EventApplicationOutcome;
      readonly conversationId?: string;
    }
  | { readonly status: 'not_processable' }
  | { readonly status: 'no_pending_event' };

export interface ReplyEligibility {
  readonly eligible: boolean;
  readonly reason: 'pause_active' | 'pause_inactive';
}

export interface AuthorizedResumeInput {
  readonly conversationId: string;
  readonly effectiveAt: Date;
  readonly requestKey: string;
}

export type AuthorizedResumeResult =
  | {
      readonly status: 'applied';
      readonly conversationId: string;
      readonly aiPausedUntil: Date | null;
    }
  | {
      readonly status: 'duplicate';
      readonly conversationId: string;
      readonly aiPausedUntil: Date | null;
    };

export interface ReviewerPrincipal {
  readonly reviewerRef: string;
  readonly roles: readonly string[];
}

interface ConsentCommandBase {
  readonly identity: ChannelIdentitySelector;
  readonly action: 'grant' | 'revoke';
  readonly category: string;
  readonly wording: string;
  readonly wordingVersion: string;
  readonly sourceAt: Date;
  readonly idempotencyKey: string;
}

export interface CustomerMessageConsentCommand extends ConsentCommandBase {
  readonly source: 'customer_message';
  readonly sourceWebhookEventId: string;
}

export interface ReviewerRecordedConsentCommand extends ConsentCommandBase {
  readonly source: 'reviewer_recorded';
}

export type ConsentCommand = CustomerMessageConsentCommand | ReviewerRecordedConsentCommand;
