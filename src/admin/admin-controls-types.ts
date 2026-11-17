import type { AdminAccountSummary } from '../persistence/postgres-admin-identity.js';
import type { AdminRole } from '../persistence/postgres-admin-identity.js';
import type { OutboundPurpose } from '../outbound/outbound-types.js';

export type { AdminAccountSummary, AdminRole };

export interface AdminStaffCreateResult {
  readonly accountRef: string;
  readonly loginName: string;
  readonly roles: readonly AdminRole[];
  readonly base32Secret: string;
  readonly provisioningUri: string;
  readonly status: 'applied' | 'duplicate';
}

export interface AdminPauseStateSummary {
  readonly conversationId: string;
  readonly contactId: string;
  readonly channel: 'messenger' | 'whatsapp';
  readonly externalContactId: string;
  readonly aiPausedUntil: Date | null;
  readonly lastAuthorizedResumeAt: Date | null;
  readonly lastActivityAt: Date;
  readonly lastPauseAction: 'pause' | 'resume' | null;
  readonly lastPauseActorKind: 'business_echo' | 'reviewer' | null;
  readonly lastPauseEffectiveAt: Date | null;
}

export interface AdminPrivacyRequestSummary {
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
  readonly contactId: string | null;
  readonly receivedAt: Date;
  readonly decisionAt: Date | null;
  readonly completedAt: Date | null;
  readonly decisionCode: string | null;
  readonly reasonCode: string | null;
  readonly pendingLocations: number;
  readonly totalLocations: number;
  readonly deletionStatus: string | null;
  readonly tombstonesCreated: number | null;
  readonly accessStatus: string | null;
  readonly accessRecordCount: number | null;
  readonly accessBundleSha256: string | null;
  readonly correctionResultCode: string | null;
  readonly correctionFieldKey: string | null;
}

export interface AdminPrivacyLocationSummary {
  readonly requestRef: string;
  readonly locationCode: string;
  readonly required: boolean;
  readonly state: 'completed' | 'failed' | 'not_applicable' | 'pending';
  readonly outcomeCode: string | null;
  readonly reviewerReference: string | null;
  readonly checkedAt: Date | null;
}

export interface AdminPrivacyAccessBundleEntry {
  readonly channel: 'messenger' | 'whatsapp';
  readonly externalContactId: string;
  readonly occurredAt: string | null;
  readonly eventKind: string | null;
  readonly sanitizedText: string | null;
}

export interface AdminPrivacyAccessBundle {
  readonly requestRef: string;
  readonly contactId: string;
  readonly preferredLanguage: string | null;
  readonly recordCount: number;
  readonly bundleSha256: string;
  readonly status: 'applied' | 'duplicate';
  readonly entries: readonly AdminPrivacyAccessBundleEntry[];
}

export interface AdminConsentIdentitySummary {
  readonly channelIdentityId: string;
  readonly contactId: string;
  readonly channel: 'messenger' | 'whatsapp';
  readonly channelAccountId: string;
  readonly externalContactId: string;
  readonly preferredLanguage: string | null;
  readonly categoryStates: Readonly<
    Record<string, { readonly action: 'grant' | 'revoke'; readonly sourceAt: Date }>
  >;
}

export interface AdminOutboundPolicySummary {
  readonly policyRef: string;
  readonly versionNumber: number;
  readonly state: 'active' | 'approved' | 'draft' | 'retired' | 'submitted';
  readonly perContact15Minute: number;
  readonly perContact24Hour: number;
  readonly global1Minute: number;
  readonly globalUtcDay: number;
  readonly createdAt: Date;
}

export interface AdminOutboundTemplateSummary {
  readonly templateRef: string;
  readonly versionNumber: number;
  readonly channelAccountId: string;
  readonly templateName: string;
  readonly locale: 'bn_BD' | 'en_US';
  readonly category: OutboundPurpose;
  readonly state: 'active' | 'approved' | 'draft' | 'retired' | 'submitted';
  readonly createdAt: Date;
}

export interface AdminWebsiteSnapshotSummary {
  readonly snapshotRef: string;
  readonly sourceRef: string;
  readonly approvedUrl: string;
  readonly label: string;
  readonly fetchedAt: Date;
  readonly sourceSha256: string | null;
  readonly contentSha256: string | null;
  readonly excerpt: string | null;
}
