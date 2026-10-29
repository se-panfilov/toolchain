# reHistory audit after tooling migrations

Review date: 2026-10-29.
Package: `tx-rehistory@2.3.3`.

## Scope and review passes

The first pass examined all six runtime modules, build and test configuration, package metadata, tests, and operating instructions.
It used the Toolchain workflow, code simplification guidance, and sharp edges analysis.
The initial working tree was clean.
No production distribution redesign was applied during this audit.

The second pass examined security separately from the quality recommendations.
It traced inputs through validation, Git calls, file operations, terminal output, and recovery paths.
A separate process exercised the built JavaScript against adversarial synthetic repositories.
These checks used both SHA-1 and SHA-256.
They did not use Toolchain as a destructive fixture.

The third pass checked application behavior, including real pseudoterminal interaction and the installed npm archive.
The reviewing agent did not create Toolchain commits, branches, tags, or publications.

## Confirmed defect: fixed

**P2: Export verification could silently inspect a parent repository.**

Affected code: [export verifier](../apps/reHistory/src/export.ts), `checkExportFiles` and `verifyExport`.
Regression tests: [export features](../apps/reHistory/test/features.test.ts).

The previous file check accepted a directory containing only a copied export manifest.
When that directory was inside a bare repository, Git discovered the parent repository.
The verifier checked the parent's refs and objects, then reported success for the incomplete child directory.
The reproducer returned `ok: true` with no errors.
This occurred with both object formats.
No repository write occurred during the reproduction.

The impact was a false verification result and inspection of an unintended repository.
It was not a demonstrated source rewrite or command execution vulnerability.

The fix requires HEAD, config, objects, and refs inside the selected directory before constructing a repository wrapper.
The existing file checks validate their allowed kinds and contents.
The verifier also compares the canonical Git directory and common directory with the selected root.
This prevents silent substitution by repository discovery.

Two regression tests failed before the fix and passed afterward.
An additional test checks each missing required element.
The tests compare fixture bytes before and after verification.

## Quality and improvement findings

These are follow-up recommendations, not additional demonstrated data-loss defects.
P2 identifies an operational limit with higher priority. P3 identifies maintenance improvements.

| Priority | Location                                                                                                                                                   | Observation                                                                                               | Suggested action                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| P2       | [engine](../apps/reHistory/src/engine.ts), `runGit`                                                                                                        | Git calls have no timeout. Response and plan limits do not bound all process time or memory use.          | Add command-specific budgets and cancellation tests. Treat interrupted write commands and recovery separately.          |
| P3       | [engine](../apps/reHistory/src/engine.ts), `makePlan`; [export](../apps/reHistory/src/export.ts), `exportPlan`                                             | Commit and object loops repeatedly start Git processes. Bundling does not reduce those calls.             | Profile large fixtures, then consider a binary-safe cat-file batch reader. Preserve object hashes and byte comparisons. |
| P3       | [Vite config](../apps/reHistory/vite.config.mjs), [build wrapper](../apps/reHistory/scripts/build.mjs), [package metadata](../apps/reHistory/package.json) | The six-module output list is repeated in several files.                                                  | Use one build manifest and an independent archive allowlist check. Keep publication narrow.                             |
| P3       | [build wrapper](../apps/reHistory/scripts/build.mjs), `build`                                                                                              | The wrapper writes Vite output to a temporary directory, then reads it back before publication.           | Consider Vite write:false and validate returned output records before publication. Keep destination link checks.        |
| P3       | [Vite config](../apps/reHistory/vite.config.mjs), preserveModules                                                                                          | Six distribution modules support built-module subprocess tests. A CLI can also use one executable bundle. | Compare a single bundle against current tests before changing the distribution contract.                                |
| P3       | [CLI](../apps/reHistory/src/cli.ts), `parseDate`, `parseStart`, and `main`                                                                                 | Pure parsers and terminal orchestration share one module. Tests import the larger CLI dependency graph.   | Extract pure input parsers and keep a small executable entry point. Preserve date and cancellation behavior.            |
| P3       | [demo](../apps/reHistory/src/demo.ts), `runRemoteProbe`                                                                                                    | Object.create and a cast create a partial Repository without its common-directory field.                  | Introduce a smaller Git-runner interface for probing instead of pretending that the probe is a complete repository.     |
| P3       | [export](../apps/reHistory/src/export.ts), `loadManifest` and `verifyExport`; [CLI](../apps/reHistory/src/cli.ts)                                          | Some validation failures return a report. Others throw and produce stderr instead of a JSON report.       | Define one machine-readable failure contract while retaining nonzero exit codes and operational diagnostics.            |

## Build experiments

Both experiments used temporary output and left production configuration unchanged.

### Vite output without a staging directory

With `build.write: false`, Vite returned all six expected JavaScript chunks.
The output directory was not created.
This can remove the temporary-directory write/read cycle from the wrapper.
Filename, chunk-type, destination, permission, and failure checks would still be necessary.
The current safe publication logic must not be replaced with unchecked bundler output.

### Single executable bundle

A single-entry experiment produced one ESM file of 74,042 bytes.
The current six runtime files totalled 75,540 bytes.
The measured size reduction was approximately 2 percent.
Help, JSON audit, and export verification passed on Node.js 24.12.0.

The experiment did not receive the full rewrite, failure, and demo regression suite.
It is evidence for a possible simplification, not a production-ready migration.
Its main potential benefit is simpler artifact management, rather than a significant size or Git performance improvement.

## Separate security pass

The built-code probes checked these boundaries for both object formats:

- A valid generated export passes verification.
- A manifest-only child directory cannot select a parent repository.
- Missing HEAD, config, objects, or refs causes rejection.
- Symbolic links and hard links in export metadata cause rejection.
- An include directive in exported Git config causes rejection before repository processing.
- Inherited Git routing variables do not redirect the audit.
- JSON output contains no literal terminal escape characters.
- Human-readable audit output sanitizes malicious identity control characters.
- Read-only operations preserve source and verification fixture bytes.

The static pass also checked argument arrays, protocol defaults, signature removal, ref transactions, lock handling, and recovery files.
No additional confirmed command injection or source mutation was observed in these checks.
The documented trust conditions remain necessary.

## Application checks

The baseline formatting, lint, type-check, and test command passed all 78 tests.
After the fix, the complete command passed all 81 tests on Node.js 24.12.0 on macOS.
The three new regressions also passed on Node.js 26.5.1.
The complete post-fix suite was not repeated on Node.js 26.5.1.

The pseudoterminal pass used the actual interactive CLI against three synthetic commits and annotated tags.
It supplied editable date and time values and selected answers through terminal key sequences.
Dry-run preserved all source file bytes.
The real rewrite preserved the backup branch and another branch.
All author and committer dates matched the selected time and interval.
Interactive export preserved the source and passed JSON export verification.

## Dependencies and archive

A fresh npm dependency audit reported zero known vulnerabilities for the locked tree.
No dependency was added or changed during this review.
A clean offline installation with disabled scripts passed formatting, lint, and build checks.
Its six runtime modules matched the local build byte-for-byte.

The actual archive contained exactly 11 expected regular files with matching bytes and permissions.
The CLI mode was 0755. Other archived files used 0644.
All six modules passed Node.js 24.12.0 syntax checks.
Offline npm exec ran help and a read-only JSON audit outside the source directory.
The archived export implementation accepted valid output and rejected an unexpected nested file.
The source and verification fixtures remained unchanged.

Gitleaks found no secrets in application source, tests, build scripts, or the extracted archive.
The checked archive integrity value is:

```text
sha512-bQvlyi0BK4x4c5xKEe38sVTxXl6qCleIHPMUFT4ZkxypHii8ojC8OkJIUwVj0WROCScRoDycxtegeXiwXEyKLA==
```

Any included-file or package metadata change requires another archive check.

## Remaining limits

The application assumes trusted Node.js and Git executables, controlled source configuration, and exclusive filesystem access during operations.
Git execution time, repository size, and aggregate memory use remain incompletely bounded.
Build publication can leave partial generated output after an I/O failure. Startup stops on this failure.
The export manifest is unsigned and does not prove the absence of personal data in messages or file contents.
Verification checks policy consistency. It does not prove the actual time of development.
Native Windows and Linux checks were not performed.
No real network demo or npm publication was performed.
This audit is evidence for the checked cases, not a security certificate.

## References

- [Git repository discovery and environment](https://git-scm.com/docs/git).
- [Git canonical repository directory queries](https://git-scm.com/docs/git-rev-parse).
- [Vite build.write](https://vite.dev/config/build-options.html#build-write).
- [Vite JavaScript build API](https://vite.dev/guide/api-javascript.html#build).
- [Node.js subprocess timeout and buffer controls](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options).
