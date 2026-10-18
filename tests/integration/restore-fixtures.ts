import type pg from 'pg';

/** Synthetic, already reviewed recovery: isolates source quarantine from the global hold. */
export async function seedReviewedRestore(
  pool: pg.Pool,
  restoreRef: string,
  at: Date,
): Promise<void> {
  const accountRef = 'ADMIN_TEST_reviewed_restore_fixture';
  await pool.query(
    `insert into admin_accounts
    (account_ref,login_name,password_algorithm,password_cost,password_block_size,password_parallelization,
     password_key_length,password_salt,password_hash,state,created_at,updated_at,password_changed_at)
    values($1,'synthetic.restore.fixture','scrypt_v1',16384,8,1,32,$2,$3,'active',$4,$4,$4)
    on conflict(account_ref) do nothing`,
    [accountRef, Buffer.alloc(16, 0x41), Buffer.alloc(32, 0x42), at],
  );
  const account = (
    await pool.query<{ id: string }>('select id from admin_accounts where account_ref=$1', [
      accountRef,
    ])
  ).rows[0];
  if (account === undefined) throw new Error('synthetic_restore_actor_missing');
  await pool.query(
    `insert into admin_role_assignments(account_id,role,action,actor_account_id,effective_at,request_key)
    values($1,'administrator','assign',$1,$2,'REQUEST_TEST_reviewed_restore_fixture') on conflict(request_key) do nothing`,
    [account.id, at],
  );
  await pool.query(
    'insert into runtime_recovery_holds(restore_ref,created_at,quarantined_count) values($1,$2,0)',
    [restoreRef, at],
  );
  await pool.query(
    `insert into runtime_recovery_reviews
    (restore_ref,reviewer_account_id,reviewed_at,consent_reconciled,suppression_reconciled,pause_reconciled,privacy_reconciled,channel_policy_reconciled)
    values($1,$2,$3,true,true,true,true,true)`,
    [restoreRef, account.id, at],
  );
}
