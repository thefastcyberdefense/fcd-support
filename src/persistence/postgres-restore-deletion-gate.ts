import type pg from 'pg';

import {
  parseRestoreDeletionBatchInput,
  parseRestoreDeletionFinalizeInput,
} from '../policy/deletion-command.js';
import { createIdentityHmac, requirePrivacyHmacKeyring } from '../policy/privacy-identity.js';
import type {
  PrivacyHmacKeyring,
  RestoreDeletionBatchInput,
  RestoreDeletionBatchResult,
  RestoreDeletionFinalizeInput,
} from '../policy/policy-types.js';
import { eraseLockedIdentities, type LockedDeletionIdentity } from './postgres-deletion-erasure.js';
import { PolicyIdempotencyConflictError } from './postgres-takeover-policy.js';
import { withBoundedTransaction } from './postgres-transaction.js';

export class RestoreDeletionKeyVersionError extends Error {
  public override readonly name = 'RestoreDeletionKeyVersionError';
}

export class RestoreDeletionGateNotReadyError extends Error {
  public override readonly name = 'RestoreDeletionGateNotReadyError';
}

interface ActiveTombstoneRow {
  readonly channel: 'messenger' | 'whatsapp';
  readonly identity_hmac: string;
  readonly key_version: string;
}

interface ExistingGateRow {
  readonly action: 'finalize' | 'reapply_batch';
  readonly evaluated_at: Date;
  readonly gate_ref: string;
  readonly git_revision: string;
  readonly identities_processed: number;
  readonly remaining_matches: number;
  readonly required_key_versions: string[];
  readonly status: 'applied' | 'failed' | 'passed';
}

interface LatestBatchRow {
  readonly git_revision: string;
  readonly remaining_matches: number;
  readonly required_key_versions: string[];
  readonly status: 'applied' | 'failed';
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function commandMatchesEvidence(
  command: RestoreDeletionBatchInput | RestoreDeletionFinalizeInput,
  expectedAction: ExistingGateRow['action'],
  evidence: ExistingGateRow,
): boolean {
  return (
    evidence.action === expectedAction &&
    evidence.gate_ref === command.gateRef &&
    evidence.git_revision === command.gitRevision &&
    evidence.evaluated_at.getTime() === command.evaluatedAt.getTime() &&
    arraysEqual(evidence.required_key_versions, command.requiredKeyVersions)
  );
}

export class PostgresRestoreDeletionGate {
  private readonly keyring: PrivacyHmacKeyring;

  public constructor(
    private readonly pool: pg.Pool,
    keyring: PrivacyHmacKeyring,
  ) {
    this.keyring = requirePrivacyHmacKeyring(keyring);
  }

  public async reapplyBatch(input: unknown): Promise<RestoreDeletionBatchResult> {
    const command = parseRestoreDeletionBatchInput(input);
    this.requireConfiguredVersions(command.requiredKeyVersions);

    return withBoundedTransaction(this.pool, async (client) => {
      await this.lockCommand(client, command.requestKey, command.gateRef);
      const replay = await this.findReplay(client, command.requestKey);
      if (replay !== undefined) {
        if (
          replay.status !== 'applied' ||
          !commandMatchesEvidence(command, 'reapply_batch', replay)
        ) {
          throw new PolicyIdempotencyConflictError('Restore batch key material conflicts');
        }
        return {
          identitiesProcessed: replay.identities_processed,
          remainingMatches: replay.remaining_matches,
          status: 'duplicate',
        };
      }

      const tombstones = await this.loadActiveTombstones(client, command);
      const identities = await this.lockRawIdentities(client);
      const matches = this.findMatches(identities, tombstones, command.requiredKeyVersions);
      const selected = matches.slice(0, command.limit);
      const erasure = await eraseLockedIdentities(client, this.keyring, selected);
      const remainingMatches = matches.length - selected.length;
      await client.query(
        `insert into restore_deletion_gates
           (gate_ref, request_key, action, status, evaluated_at, git_revision,
            required_key_versions, identities_processed, remaining_matches, completed_at)
         values ($1, $2, 'reapply_batch', 'applied', $3, $4, $5, $6, $7, $3)`,
        [
          command.gateRef,
          command.requestKey,
          command.evaluatedAt,
          command.gitRevision,
          [...command.requiredKeyVersions],
          erasure.identitiesPseudonymized,
          remainingMatches,
        ],
      );
      return {
        identitiesProcessed: erasure.identitiesPseudonymized,
        remainingMatches,
        status: 'applied',
      };
    });
  }

  public async finalizeGate(input: unknown): Promise<{ readonly status: 'passed' }> {
    const command = parseRestoreDeletionFinalizeInput(input);
    this.requireConfiguredVersions(command.requiredKeyVersions);

    return withBoundedTransaction(this.pool, async (client) => {
      await this.lockCommand(client, command.requestKey, command.gateRef);
      const replay = await this.findReplay(client, command.requestKey);
      if (replay !== undefined) {
        if (replay.status !== 'passed' || !commandMatchesEvidence(command, 'finalize', replay)) {
          throw new PolicyIdempotencyConflictError('Restore finalize key material conflicts');
        }
        return { status: 'passed' };
      }

      const tombstones = await this.loadActiveTombstones(client, command);
      const failed = await client.query(
        `select id
         from restore_deletion_gates
         where gate_ref = $1 and action = 'reapply_batch' and status = 'failed'
         limit 1`,
        [command.gateRef],
      );
      const latest = await client.query<LatestBatchRow>(
        `select status, remaining_matches, git_revision, required_key_versions
         from restore_deletion_gates
         where gate_ref = $1 and action = 'reapply_batch'
         order by id desc
         limit 1
         for update`,
        [command.gateRef],
      );
      const latestBatch = latest.rows[0];
      if (
        failed.rows[0] !== undefined ||
        latestBatch?.status !== 'applied' ||
        latestBatch.remaining_matches !== 0 ||
        latestBatch.git_revision !== command.gitRevision ||
        !arraysEqual(latestBatch.required_key_versions, command.requiredKeyVersions)
      ) {
        throw new RestoreDeletionGateNotReadyError('Restore deletion evidence is incomplete');
      }

      const identities = await this.lockRawIdentities(client, false);
      const remaining = this.findMatches(
        identities,
        tombstones,
        command.requiredKeyVersions,
      ).length;
      if (remaining !== 0) {
        throw new RestoreDeletionGateNotReadyError('Restored identities still match tombstones');
      }
      const existingPass = await client.query(
        `select id from restore_deletion_gates
         where gate_ref = $1 and action = 'finalize' and status = 'passed'
         for update`,
        [command.gateRef],
      );
      if (existingPass.rows[0] !== undefined) {
        throw new PolicyIdempotencyConflictError('Restore gate was finalized with another key');
      }
      await client.query(
        `insert into restore_deletion_gates
           (gate_ref, request_key, action, status, evaluated_at, git_revision,
            required_key_versions, identities_processed, remaining_matches, completed_at)
         values ($1, $2, 'finalize', 'passed', $3, $4, $5, 0, 0, $3)`,
        [
          command.gateRef,
          command.requestKey,
          command.evaluatedAt,
          command.gitRevision,
          [...command.requiredKeyVersions],
        ],
      );
      return { status: 'passed' };
    });
  }

  private requireConfiguredVersions(requiredVersions: readonly string[]): void {
    for (const version of requiredVersions) {
      if (!this.keyring.keys.has(version)) {
        throw new RestoreDeletionKeyVersionError('A required restore key version is unavailable');
      }
    }
  }

  private async lockCommand(
    client: pg.PoolClient,
    requestKey: string,
    gateRef: string,
  ): Promise<void> {
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint)),
              pg_advisory_xact_lock(hashtextextended($2::text, 1::bigint))`,
      [requestKey, gateRef],
    );
  }

  private async findReplay(
    client: pg.PoolClient,
    requestKey: string,
  ): Promise<ExistingGateRow | undefined> {
    const selected = await client.query<ExistingGateRow>(
      `select gate_ref, action, status, evaluated_at, git_revision,
              required_key_versions, identities_processed, remaining_matches
       from restore_deletion_gates where request_key = $1
       for update`,
      [requestKey],
    );
    return selected.rows[0];
  }

  private async loadActiveTombstones(
    client: pg.PoolClient,
    command: RestoreDeletionBatchInput | RestoreDeletionFinalizeInput,
  ): Promise<readonly ActiveTombstoneRow[]> {
    const selected = await client.query<ActiveTombstoneRow>(
      `select identity_hmac, channel, key_version
       from privacy_suppressions
       where category = 'deletion_tombstone'
         and effective_at <= $1
         and (expires_at is null or expires_at > $1)
       order by id
       for share`,
      [command.evaluatedAt],
    );
    const required = new Set(command.requiredKeyVersions);
    for (const tombstone of selected.rows) {
      if (!required.has(tombstone.key_version) || !this.keyring.keys.has(tombstone.key_version)) {
        throw new RestoreDeletionKeyVersionError(
          'An active tombstone key version is not covered by the restore gate',
        );
      }
    }
    return selected.rows;
  }

  private async lockRawIdentities(
    client: pg.PoolClient,
    skipLocked = true,
  ): Promise<readonly LockedDeletionIdentity[]> {
    const lockClause = skipLocked ? 'for update skip locked' : 'for update';
    const selected = await client.query<LockedDeletionIdentity>(
      `select id, channel, channel_account_id, external_contact_id
       from channel_identities
       where channel_account_id !~ '^deleted:[0-9a-f-]{36}$'
          or external_contact_id !~ '^deleted:[0-9a-f-]{36}$'
       order by id
       ${lockClause}`,
    );
    return selected.rows;
  }

  private findMatches(
    identities: readonly LockedDeletionIdentity[],
    tombstones: readonly ActiveTombstoneRow[],
    requiredVersions: readonly string[],
  ): LockedDeletionIdentity[] {
    const tombstoneSet = new Set(
      tombstones.map(
        (tombstone) =>
          `${tombstone.key_version}\u0000${tombstone.channel}\u0000${tombstone.identity_hmac}`,
      ),
    );
    return identities.filter((identity) =>
      requiredVersions.some((version) => {
        const key = this.keyring.keys.get(version);
        if (key === undefined) return false;
        const hmac = createIdentityHmac(
          {
            channel: identity.channel,
            channelAccountId: identity.channel_account_id,
            externalContactId: identity.external_contact_id,
          },
          { key, version },
        );
        return tombstoneSet.has(`${version}\u0000${identity.channel}\u0000${hmac}`);
      }),
    );
  }
}
