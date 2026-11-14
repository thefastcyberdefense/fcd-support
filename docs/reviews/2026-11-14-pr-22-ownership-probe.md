# Frozen PR 22 Ownership Review Reproduction

This is a documentation artifact, not an application module or a passing test
for a future fix. Every identity and timestamp is authored. Every signal port
is fake. Only the two exact local Git blobs named below are read. Exit 0 means
the submitted regressions reproduce against their base; no real process is
signaled. Run the fenced JavaScript on Node 24 from the repository root using
the extraction command in the [review](2026-11-14-pr-22-23-review.md).

```javascript
// Frozen, authored review reproduction. Never signals a real process.
// All process identities and timestamps below are synthetic; Git reads are local.
// Exit 0 means both regressions reproduce in the reviewed head versus its base,
// not that a later correction is verified. Do not use this as a repair executor.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const revisions = [
  '94c95423feed20c866c9ab4a009ddde146674f57',
  'fc5bfd8ccb1129bd3dc8fad8c867d9a2be7a4399',
];
async function load(revision) {
  const source = execFileSync('git', ['show', revision + ':tests/helpers/process-lifecycle.ts'], {
    encoding: 'utf8',
  });
  const helperUrl = pathToFileURL(resolve('tests/helpers/process-lifecycle.ts')).href;
  const js = stripTypeScriptTypes(source).replaceAll('import.meta.url', JSON.stringify(helperUrl));
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}
function fakeChild() {
  const stream = () => ({
    closed: false,
    destroy() {
      this.closed = true;
    },
  });
  const child = Object.assign(new EventEmitter(), {
    pid: 77771,
    exitCode: null,
    signalCode: null,
    kill() {
      return true;
    },
    stdin: stream(),
    stdout: stream(),
    stderr: stream(),
  });
  return {
    child,
    close() {
      child.exitCode = 0;
      for (const key of ['stdin', 'stdout', 'stderr']) child[key].closed = true;
    },
  };
}
async function recycle(revision) {
  const { captureProcessTreeOwnership, reapChildProcess } = await load(revision);
  const { child, close } = fakeChild();
  let phase = 'capture';
  let query = 0;
  let unrelatedAlive = true;
  let unrelatedKill = false;
  const ops = {
    async readMsysSnapshot() {
      return {
        ok: true,
        rows:
          phase === 'capture'
            ? [
                { pid: 910, ppid: 1, pgid: 910, winPid: 77771, uid: 1000 },
                { pid: 920, ppid: 910, pgid: 910, winPid: 77772, uid: 1000 },
              ]
            : unrelatedAlive
              ? [{ pid: 9999, ppid: 1, pgid: 9999, winPid: 77772, uid: 1000 }]
              : [],
      };
    },
    async readWmiSnapshot() {
      if (phase === 'capture' && ++query === 1)
        return { ok: true, rows: [{ pid: 77771, parentPid: 1, creationUs: 1000n }] };
      close();
      return {
        ok: true,
        rows: unrelatedAlive ? [{ pid: 77772, parentPid: 1, creationUs: 999999n }] : [],
      };
    },
    async killWinPid(pid) {
      if (pid === 77772) {
        unrelatedKill = true;
        unrelatedAlive = false;
      }
    },
    async killMsysTargets() {},
  };
  const ownership = await captureProcessTreeOwnership(child, { timeoutMs: 500, _winTreeOps: ops });
  phase = 'reap';
  close();
  let cleanup = 'resolved';
  try {
    await reapChildProcess(child, {
      termTimeoutMs: 200,
      killTimeoutMs: 200,
      processGroup: true,
      _winTreeOps: ops,
    });
  } catch {
    cleanup = 'rejected';
  }
  return {
    case: 'capture-recycle',
    revision,
    unrelatedCaptured: ownership.ownedWinNodes.has(77772),
    unrelatedKill,
    cleanup,
  };
}
async function nativeGrandchild(revision) {
  const { captureProcessTreeOwnership, reapChildProcess } = await load(revision);
  const { child, close } = fakeChild();
  let phase = 'capture';
  let nativeChildAlive = true;
  let nativeGrandchildAlive = true;
  const ops = {
    async readMsysSnapshot() {
      return {
        ok: true,
        rows:
          child.exitCode === null
            ? [{ pid: 910, ppid: 1, pgid: 910, winPid: 77771, uid: 1000 }]
            : [],
      };
    },
    async readWmiSnapshot(_timeout, filter) {
      const rows = [
        ...(child.exitCode === null ? [{ pid: 77771, parentPid: 1, creationUs: 1000n }] : []),
        ...(phase === 'reap' && nativeChildAlive
          ? [{ pid: 77772, parentPid: 77771, creationUs: 2000n }]
          : []),
        ...(phase === 'reap' && nativeGrandchildAlive
          ? [{ pid: 77773, parentPid: 77772, creationUs: 3000n }]
          : []),
      ];
      return {
        ok: true,
        rows: rows.filter(
          (row) =>
            filter === undefined || filter.includes(row.pid) || filter.includes(row.parentPid),
        ),
      };
    },
    async killWinPid(pid) {
      if (pid === 77771) close();
      if (pid === 77772) nativeChildAlive = false;
      if (pid === 77773) nativeGrandchildAlive = false;
    },
    async killMsysTargets() {},
  };
  const ownership = await captureProcessTreeOwnership(child, { timeoutMs: 500, _winTreeOps: ops });
  ownership.capturedAtMs = Date.now() - 1000;
  phase = 'reap';
  let cleanup = 'resolved';
  try {
    await reapChildProcess(child, {
      termTimeoutMs: 200,
      killTimeoutMs: 200,
      processGroup: true,
      _winTreeOps: ops,
    });
  } catch {
    cleanup = 'rejected';
  }
  return { case: 'native-grandchild', revision, nativeChildAlive, nativeGrandchildAlive, cleanup };
}
const observed = [];
for (const revision of revisions) {
  const capture = await recycle(revision);
  const native = await nativeGrandchild(revision);
  observed.push(capture, native);
  console.log(JSON.stringify(capture));
  console.log(JSON.stringify(native));
}
assert.equal(observed[0].unrelatedCaptured, false);
assert.equal(observed[0].unrelatedKill, false);
assert.equal(observed[1].nativeGrandchildAlive, false);
assert.equal(observed[2].unrelatedCaptured, true);
assert.equal(observed[2].unrelatedKill, true);
assert.equal(observed[3].nativeGrandchildAlive, true);
assert.equal(observed[3].cleanup, 'resolved');
```
