# reHistory poll and archive publication review

## Summary

The external review identified one confirmed low-severity cancellation defect and one valid publication recommendation.
Both are fixed in reHistory 2.5.4.
No unresolved high-severity finding was identified within this review scope.
The recommendation is to accept these fixes after the configured platform CI checks.

| Finding                                                             | Initial impact                                       | Resolution                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| SIGINT queued during synchronous application after I/O confirmation | Cancellation could be lost before the push question. | Retain the listener and wait across the next poll phase. |
| Publication repacked the working directory                          | Publication could differ from the preceding archive. | Pass the created archive explicitly to npm publish.      |

## Baseline and scope

The review started from commit 3ceb278.
Git blame identified commit 18749f0 as the earlier one-turn interruption fix.
That implementation did not cover confirmation resumed from the poll phase.

The review covers engine.ts, cli.ts, the new publication helper, both affected test files, package metadata, and operating documentation.
The root lockfile was checked for the application version update.
The shared tooling, Git transport implementation, and unrelated user changes were not modified.
This is a focused differential review, not a new audit of every repository feature or npm account setting.

There are two production callers of applyPlan: the interactive CLI and the synthetic demo.
The interactive CLI checks the interruption flag before offering push.
The demo has no push after the rewrite and retains its existing behavior.
The publication helper has one entry through the application's release script.

## Cancellation finding and fix

The original CLI test resolved confirmation through an async function without I/O.
A new test resolves the final confirmation from the data callback of a real stdin pipe.
The remaining prompts are automated, and TTY detection is supplied by the test preload.
This tests the relevant event-loop phase without claiming a native terminal session.

Before the fix, the microtask case passed and the stdin case exited with code zero instead of 130.
After the fix, both cases pass.
Both assert a saved rewrite, removed lock, exit code 130, and no push question.

The engine now schedules listener removal through two nested setImmediate callbacks.
The CLI waits for the same two check phases before reading the flag.
This includes the intervening poll phase even when keyboard input started application.
The shared listener still records interruption for all pending synchronous applications.
Tests also verify listener cleanup after multiple applications.

The ref transaction, recovery file, exclusive lock, and Git environment controls are unchanged.
Cleanup still runs after application failure.
An interrupted Git child can fail and report recovery information instead of completing the transaction.
Forced termination can still leave a lock, as documented.

See [engine.ts](../apps/reHistory/src/engine.ts), [cli.ts](../apps/reHistory/src/cli.ts), and [regression tests](../apps/reHistory/test/hardening.test.ts).

## Archive publication finding and fix

The old release script packed an archive, then published the working directory.
The new script remains a short sequence: npm pack, then the publication helper.
The helper resolves the current version and passes its explicit local archive to npm.
It uses the current Node.js executable and the npm CLI supplied by npm run.
Argument arrays avoid shell interpolation and platform-specific environment expansion.

The helper accepts only --dry-run.
It rejects absent archives, symbolic links, hard links, and special files.
It preserves npm's nonzero status and does not retry publication.
Lifecycle scripts remain disabled for pack and publish.
The root check and build remain separate prerequisites, as before this review.

Tests use a synthetic npm executable to examine arguments, working directory, bytes, and failure propagation.
An isolated workspace also ran the real release:dry-run command with offline npm and empty account configuration.
A later helper dry-run used the same archive after its working README was changed.
The publication integrity still matched that archive's SHA-512 value.
No registry publication or remote push was executed.

The helper cannot isolate hostile local processes that replace the archive concurrently.
Do not modify the archive during checks or publication.
Trusted publishing and provenance remain reasonable future improvements.
They require separate registry and CI configuration and were not enabled by this task.
Two-factor authentication does not by itself attest build provenance.
No npm account authentication policy was inspected.

See [publication helper](../apps/reHistory/scripts/publish.mjs), [release tests](../apps/reHistory/test/release.test.mjs), and [npm publish documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

## Verification

- Root check passed formatting, ESLint, mandatory TypeScript checking, build, and 129 tests on Node.js 26.5.1.
- All 129 tests also passed on Node.js 24.12.0 with Git 2.56.0.
- The updated release tests passed again after adding hard-link rejection coverage.
- The actual npm archive retained its 12-file allowlist and executable CLI mode.
- Offline archive execution passed help, read-only audit, export, and negative export verification.
- Real npm offline publication dry-run used the packed archive despite a changed working README.

The checks ran on macOS.
Signal-delivery subprocess tests are skipped on Windows because POSIX SIGINT injection does not model native console control events.
Native Windows and Linux results remain subject to CI.
