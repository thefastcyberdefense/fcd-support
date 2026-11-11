# Windows helper ownership correction

Date: 2026-11-11 (Asia/Dhaka). Submitted parent:
`9bacf5e1daad08bbf8fd4f8e9de3e2b4460776bb` on draft PR #18.

Independent review confirms shared default deadlines and the improved numeric
ownership capture. A new hermetic RED control demonstrates a distinct remaining
case: all captured actors exit, and a previously owned MSYS group number is
recycled to a new unrelated WinPID born later. Birth time alone authorized its
termination. The existing reused-WinPID control did not cover this variant.

The corrected inspector freezes current groups anchored by a previously captured
CreationDate-matching member before admitting any new member. Group number/uid
and later birth alone cannot authorize ownership. Fresh verified Win32 ancestry
remains valid. The original and new reuse controls both pass; actual lifecycle
suite passes **24 tests / 1 platform skip** in **11.36 seconds**.
The regression's finally now attempts both target and canary roots independently.
Automatic capture no longer extends short explicit budgets to 1,500 ms.
Independent correction review found no new blocking issue.

## Execution evidence and limitations

- Submitted 9bacf5e full four-worker gate failed: **2,221 passed / 461 skips /
  6 failures**, 135 files, **266.97 seconds** (whole command 312.09 seconds).
  Failures affect two stall controls and four promotion-controller cases.
  This independent result is retained; AGY's passing run is not discarded.
- After the group-ownership correction, the narrower lifecycle/backup/controller
  suites pass **73 / 1 skip**, three files, **70.11 seconds**. This does not
  establish a historical load or timing cause.
- Fresh final correction `VITEST_MAX_WORKERS=4 npm run check` passes Phase 0,
  formatting, lint, strict typecheck, build and **2,228 tests / 461 skips**, 135
  files, **241.18 seconds** (whole command **288.10 seconds**). The complete
  tracked source diff is unchanged throughout the check.

The two full-run outcomes do not establish that any specific correction caused
the timing difference or that future machine load cannot expose a timeout.
Final-source disposable Linux/native CI remains necessary before acceptance.
No production controller, test timeout, assertion, server, daemon, tunnel,
provider, Meta, Manifest, n8n, account or alert was changed.
