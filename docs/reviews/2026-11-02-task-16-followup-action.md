# Task 16 fresh follow-up action review

Date: 2026-11-02 (Asia/Dhaka).
Status: **Reviewed and validated; commit/push and fresh admission precede execution.**

## Scope and decision

The original `14ff26a` executor and failed `6d0210d` deployment are immutable
history. Do not rerun that action, clear its uncertain maintenance journal,
remove its selected database or infer a SQL outcome from an absent actor.
The new `2026-11-02-final-server-followup.py` is a separate one-use executor
for a fresh full-revision namespace on the approved local test server. Existing
owner authorization covers isolated deployment with protection of other projects.

The maintenance correction is reviewed in PR #6 on `e665249`. All four of its
exact-source workflows passed before selecting the mainline
checkpoint. Mainline merge
`7af70cc77196813b92d8365567150153996b790a` has the exact validated tree
(`git diff --quiet` exit 0). The executor source comparison permits only
documentation descendants of that checkpoint. The selected source is that merge;
the action SHA256 is `49eda6f6994ae4071928fcc5cdbe545452d85aec0f937879f269ced02e98bcb0`. Commands are in the deployment runbook.

This follow-up reserves eight fresh /24 bridges within `198.19.48.0/20`, after
checking all Docker subnets, IPv4 route tables and actual interfaces. It does not
reuse the prior `198.19.32.0/20` block. Runtime roles, volumes, images, inert
synthetic ingress peer and private configuration are fresh. Model, outbound and
n8n execution stay disabled. There is no tunnel, Meta, provider or production action.

## Preservation and qualification

The original baseline remains authoritative evidence of a failed full audit.
Read-only comparison may qualify exactly the previously observed single absent
unrelated running actor, removing only its exact membership from the comparison.
It refuses a missing fcd-support actor, extra actor, duplicate observation, second
loss, survivor change, network/volume/state-file change or boot/daemon change.
This is a qualified surviving-inventory check, not restoration or attribution.

The new full baseline is captured before qualification, then rechecked. It
includes the retained failed scope and fingerprints of its original baseline,
started marker, maintenance/backup evidence and old state files. Existing state
locks stay held. A private qualification record binds the original fingerprint
and missing set; neither identifiers nor raw Docker metadata enter Git or output.
Later audit compares the new scope's saved baseline and private qualification.

## Independent review and direct correction

One fresh read-only review found an Important continuity race: qualification
preceded independent baseline capture, allowing intervening drift to be absorbed.
Codex extracted that existing order and reproduced the finding with a failing
regression (`RuntimeError not raised`). Capturing the new baseline first fixes
it. Regressions cover drift during qualification, later drift and stable admission.
No other Important/Critical issue was reported. No second review loop is required
for the reproduced, directly tested correction.

Final checks after the correction:

- Windows: **21 passed / three Unix skips**, 24 checks, 0.142 s.
- Linux via private temporary scratch: **24 passed**, 1.969 s, exit 0; scratch
  automatically removed. These are hermetic tests, with no Docker/service/database
  mutation. Real process-group descendant cleanup runs on Linux.
- The corrected action's fresh read-only server admission passed. Source execution
  selection still requires the final accepted checkpoint and repeat admission.
- The immutable predecessor's SHA256 remains
  `78e4a6e8b8f6b2cf738779e4e95ece3ba14750fb9a6487d314002f3cb8181e87`.

Reviewer boundaries were assessed explicitly: PR #6 correctness/CI is a separate
integration prerequisite; old SQL settlement and loss attribution remain outside
authority; sudo timer installation and actual SSH/admin proof remain later Task 16
steps; live capacity and inventory require fresh admission; the source
anchor is finalized to accepted `7af70cc`; Linux tests are now executed as above.
No deferred minor finding was reported.

## Remaining completion boundary

A successful private deployment must run real backup/replay, all maintenance
subcommands and health, render the four verified units and pass runtime/audit
checks. It does not install timers or complete Task 16 by itself. Passwordless
sudo remains unavailable; no host policy or other project is changed to bypass it.
Actual SSH loopback forwarding, login/origin proof, privileged unit installation
and consolidated handoff remain required. Any failure preserves this new scope
and stops it without automatic retry or old-scope cleanup.
