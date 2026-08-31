export type LifecycleClass = 'active_client' | 'casual_chat' | 'unconverted_lead';

export interface QualifyingRetentionEventInput {
  readonly conversationId: string;
  readonly sourceWebhookEventId: string;
  readonly targetClass: 'casual_chat' | 'unconverted_lead';
  readonly requestKey: string;
}

export interface ActiveRelationshipStartInput {
  readonly conversationId: string;
  readonly relationshipStartedAt: Date;
  readonly effectiveAt: Date;
  readonly requestKey: string;
}

export interface ActiveRelationshipReviewInput {
  readonly conversationId: string;
  readonly reviewedAt: Date;
  readonly requestKey: string;
}

export interface ActiveRelationshipCloseInput {
  readonly conversationId: string;
  readonly relationshipEndedAt?: Date;
  readonly finalPaidServiceCompletedAt?: Date;
  readonly effectiveAt: Date;
  readonly requestKey: string;
}

export interface RetentionReclassificationInput {
  readonly conversationId: string;
  readonly targetClass: 'casual_chat' | 'unconverted_lead';
  readonly effectiveAt: Date;
  readonly requestKey: string;
}

export interface RetentionJobInput {
  readonly evaluatedAt: Date;
  readonly limit: number;
  readonly requestKey: string;
}

export interface RetentionJobResult {
  readonly status: 'applied' | 'duplicate';
  readonly conversationsProcessed: number;
  readonly messagesPurged: number;
}

export interface ChannelIdentitySelector {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly externalContactId: string;
}

export interface PrivacyHmacKey {
  readonly key: Buffer;
  readonly version: string;
}

export interface PrivacyHmacKeyring {
  readonly activeVersion: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface OpenDeletionRequestInput {
  readonly identity: ChannelIdentitySelector;
  readonly requestedAt: Date;
  readonly requestKey: string;
  readonly sourceWebhookEventId: string;
}

interface ReviewDeletionRequestBase {
  readonly confirmationWebhookEventId: string;
  readonly decidedAt: Date;
  readonly requestKey: string;
  readonly requestRef: string;
  readonly verificationMethod: 'explicit_confirmation' | 'known_name';
}

export type ReviewDeletionRequestInput = ReviewDeletionRequestBase &
  (
    | { readonly decision: 'approve'; readonly reasonCode: 'customer_confirmed' }
    | {
        readonly decision: 'reject';
        readonly reasonCode: 'identity_ambiguous' | 'request_withdrawn';
      }
  );

export interface ExecuteDeletionInput {
  readonly executedAt: Date;
  readonly requestKey: string;
  readonly requestRef: string;
}

export interface DeletionExecutionResult {
  readonly conversationsProcessed: number;
  readonly identitiesPseudonymized: number;
  readonly messagesCleared: number;
  readonly requestRef: string;
  readonly status: 'applied' | 'duplicate';
  readonly tombstonesCreated: number;
}

interface RestoreDeletionGateInputBase {
  readonly evaluatedAt: Date;
  readonly gateRef: string;
  readonly gitRevision: string;
  readonly requestKey: string;
  readonly requiredKeyVersions: readonly string[];
}

export interface RestoreDeletionBatchInput extends RestoreDeletionGateInputBase {
  readonly limit: number;
}

export type RestoreDeletionFinalizeInput = RestoreDeletionGateInputBase;

export interface RestoreDeletionBatchResult {
  readonly identitiesProcessed: number;
  readonly remainingMatches: number;
  readonly status: 'applied' | 'duplicate';
}

export type EventApplicationOutcome =
  | 'business_echo_ignored_before_resume'
  | 'business_echo_paused'
  | 'customer_message_applied'
  | 'identity_suppressed'
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
  readonly reason: 'pause_active' | 'pause_inactive' | 'privacy_request_open';
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

export type ConsentRecordResult =
  | { readonly status: 'applied'; readonly consentEventId: string }
  | { readonly status: 'duplicate'; readonly consentEventId: string };

export interface MarketingEligibility {
  readonly eligible: boolean;
  readonly reason:
    | 'consent_latest_grant'
    | 'consent_latest_revoke'
    | 'consent_missing'
    | 'global_marketing_opt_out'
    | 'identity_not_found';
}

export interface ProcessPrivacyIntentInput {
  readonly requestKey: string;
  readonly sourceWebhookEventId: string;
}

interface ReviewPrivacyRequestBase {
  readonly decidedAt: Date;
  readonly requestKey: string;
  readonly requestRef: string;
  readonly verificationMethod: 'known_name' | 'same_channel_context';
}

export type ReviewPrivacyRequestInput = ReviewPrivacyRequestBase &
  (
    | { readonly decision: 'approve'; readonly reasonCode: 'identity_verified' }
    | {
        readonly decision: 'reject';
        readonly reasonCode: 'identity_ambiguous' | 'request_withdrawn';
      }
  );

export type PrivacyLocationCode =
  | 'backup_tombstone_gate'
  | 'manifest_recordings'
  | 'meta_provider'
  | 'offline_archives'
  | 'operator_exports'
  | 'pending_outbound'
  | 'primary_postgres';

export interface AttestPrivacyLocationInput {
  readonly checkedAt: Date;
  readonly locationCode: PrivacyLocationCode;
  readonly outcomeCode: 'location_complete' | 'location_failed' | 'location_not_applicable';
  readonly requestKey: string;
  readonly requestRef: string;
}

export interface CollectAccessDataInput {
  readonly collectedAt: Date;
  readonly requestKey: string;
  readonly requestRef: string;
}

export interface ExecuteCorrectionInput {
  readonly executedAt: Date;
  readonly fieldKey: string;
  readonly requestKey: string;
  readonly requestRef: string;
}

export interface MarketingOptOutInput {
  readonly effectiveAt: Date;
  readonly requestKey: string;
  readonly sourceWebhookEventId: string;
}

export interface ExplicitMarketingReoptInInput {
  readonly categories: readonly string[];
  readonly effectiveAt: Date;
  readonly identity: ChannelIdentitySelector;
  readonly requestKey: string;
  readonly scope: 'all_linked_identities' | 'source_identity';
  readonly verificationMethod: 'known_name' | 'same_channel_context';
}
