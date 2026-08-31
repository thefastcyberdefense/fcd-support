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

export const ACCESS_EXPORT_CATEGORIES = Object.freeze([
  'channel_identities',
  'conversations',
  'conversation_lifecycle',
  'webhook_events',
  'consent_history',
  'privacy_requests',
  'privacy_checklist',
] as const);

export type AccessExportCategory = (typeof ACCESS_EXPORT_CATEGORIES)[number];

export interface AccessChannelIdentityRecord {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly externalContactId: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

export interface AccessConversationRecord {
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly createdAt: Date;
  readonly externalContactId: string;
  readonly lastActivityAt: Date;
}

export interface AccessConversationLifecycleRecord {
  readonly anchorAt: Date | null;
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly contentPurgedThroughAt: Date | null;
  readonly expiresAt: Date | null;
  readonly externalContactId: string;
  readonly finalPaidServiceCompletedAt: Date | null;
  readonly lastActiveReviewAt: Date | null;
  readonly lifecycleClass: 'active_client' | 'casual_chat' | 'unconverted_lead';
  readonly nextActiveReviewAt: Date | null;
  readonly relationshipEndedAt: Date | null;
  readonly relationshipStartedAt: Date | null;
  readonly relationshipStatus: 'closed' | 'open' | null;
}

export interface AccessWebhookEventRecord {
  readonly channel: 'messenger' | 'whatsapp';
  readonly createdAt: Date;
  readonly eventKind: 'business_message_echo' | 'customer_message' | 'message_status';
  readonly externalMessageId: string | null;
  readonly messageStatus: 'delivered' | 'failed' | 'read' | 'sent' | null;
  readonly messageText: string | null;
  readonly occurredAt: Date | null;
}

export interface AccessConsentRecord {
  readonly action: 'grant' | 'revoke';
  readonly category: string;
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly createdAt: Date;
  readonly externalContactId: string;
  readonly source: 'customer_message' | 'reviewer_recorded';
  readonly sourceAt: Date;
  readonly wording: string;
  readonly wordingVersion: string;
}

export interface AccessPrivacyRequestRecord {
  readonly completedAt: Date | null;
  readonly decisionAt: Date | null;
  readonly receivedAt: Date;
  readonly requestRef: string;
  readonly requestType: 'access' | 'correction' | 'deletion';
  readonly state:
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'human_review'
    | 'in_progress'
    | 'partially_completed'
    | 'received'
    | 'rejected';
  readonly targetAt: Date | null;
}

export interface AccessPrivacyChecklistRecord {
  readonly checkedAt: Date | null;
  readonly locationCode: PrivacyLocationCode;
  readonly outcomeCode: string | null;
  readonly requestRef: string;
  readonly required: boolean;
  readonly state: 'completed' | 'failed' | 'not_applicable' | 'pending';
}

export interface AccessExportRecords {
  readonly channel_identities: readonly AccessChannelIdentityRecord[];
  readonly consent_history: readonly AccessConsentRecord[];
  readonly conversation_lifecycle: readonly AccessConversationLifecycleRecord[];
  readonly conversations: readonly AccessConversationRecord[];
  readonly privacy_checklist: readonly AccessPrivacyChecklistRecord[];
  readonly privacy_requests: readonly AccessPrivacyRequestRecord[];
  readonly webhook_events: readonly AccessWebhookEventRecord[];
}

export interface AccessDataExport {
  readonly manifest: {
    readonly collectedAt: Date;
    readonly recordCount: number;
    readonly requestRef: string;
    readonly schemaVersion: 'fcd-support.access.v1';
    readonly sourceCategories: readonly AccessExportCategory[];
  };
  readonly records: AccessExportRecords;
}

export interface AccessDataExportResult {
  readonly export: AccessDataExport;
  readonly status: 'collected' | 'duplicate';
}

export interface ExecuteCorrectionInput {
  readonly executedAt: Date;
  readonly fieldKey: string;
  readonly requestKey: string;
  readonly requestRef: string;
}

export type CorrectionResultCode =
  'applied' | 'manual_required' | 'partially_completed' | 'rejected';

export interface CorrectionExecutionResult {
  readonly fieldKey: string;
  readonly requestRef: string;
  readonly resultCode: CorrectionResultCode;
  readonly status: 'applied' | 'duplicate';
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
