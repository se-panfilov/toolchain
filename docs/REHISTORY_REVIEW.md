# reHistory security review

Review date: 2026-10-29.

## Scope and method

The review covered the six runtime modules, package metadata, build script, tests, and operating documentation.
The initial working tree was clean.
The review used source inspection, Git history, temporary baseline copies, regression tests, and an independent adversarial review.
The user changed package metadata and committed changes during this work.
The review preserved those changes.
The reviewing agent did not create Toolchain commits, branches, tags, or external publications.

The selected skills were `toolchain-cli`, `sharp-edges`, `differential-review`, `property-based-testing`, `code-simplifier`, and `agents-md`.
The property testing guidance used deterministic generated inputs without a new dependency.
The generated cases do not have automatic shrinking.

## Findings and fixes

All findings below are fixed and have regression tests.
The severity is moderate because each defect requires specific repository data or a modified export.

| Finding                        | Previous behavior                                                                                    | Fix and evidence                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Unexpected nested export files | Files inside allowed directories could pass verification. Such files could contain private metadata. | Every nested path has an explicit file or directory check. Tests add files inside objects and refs.                            |
| Extra export metadata          | Config comments, extra manifest fields, and unknown packed-ref header words could pass verification. | Strict schemas check metadata before Git reads the object store. Tests cover invalid types, duplicate entries, and extra data. |
| Missing symbolic refs          | Git omitted dangling loose symbolic refs. The audit could report complete coverage.                  | A bounded loose-file read finds omitted symbolic refs. Tests require an incomplete audit and blocked branch or tag rewriting.  |
| Tag message data loss          | Multiple signature blocks could discard ordinary message text between blocks.                        | Signature removal accepts one complete trailing block. Ambiguous blocks stop planning before writes.                           |
| Unchecked packed metadata      | Cached peeled targets or renamed pack files could retain unrelated object IDs.                       | Cached targets must match actual targets. Pack names must match embedded checksums. Tests cover SHA-1 and SHA-256.             |

Four regression tests failed against the previous implementation before the fixes.
The signature reproducer showed message bytes discarded between complete blocks.
The independent review confirmed nested-file acceptance and omitted symbolic refs.
It also examined packed exports and object files with appended data.
No additional false success remained in those probes after the fixes.

## Refactoring and affected paths

The export verifier now separates manifest validation, file validation, and Git integrity checks.
Metadata validation occurs before Git reads the exported object store.
Small helpers replace duplicated metadata checks.
Signature removal has a separate helper with byte-preservation tests.
No runtime dependency was added.

The changed ref reader affects planning, concurrency checks, audit, and export verification.
The changed signature parser affects plan construction and therefore local rewriting, export, and demo operations.
The export checks affect automatic verification after export and the explicit verification command.
Existing transaction, recovery, dry-run, environment isolation, and terminal tests remain applicable.

| Changed entry point | Direct runtime call sites |
| ------------------- | ------------------------- |
| `Repository.refs`   | 6                         |
| `stripTagSignature` | 1                         |
| `verifyExport`      | 2                         |
| `exportPlan`        | 2                         |

The counts exclude tests and function declarations.
Indirect callers include planning and demo flows.

The package file list and agent instructions no longer refer to a removed publication guide.
Historical publication checks are identified as earlier results.
Current package identity and publication settings remain under user control.

## Verification

The baseline suite passed 48 tests on Node.js 24.12.0.
The final suite passed 55 tests on Node.js 24.12.0 and 26.5.1 on macOS.
The generated signature test covers 1024 binary-message, signature-kind, and newline combinations.
It checks byte preservation, idempotence, and unchanged input buffers.
Packed export tests cover both Git object formats.
The synthetic demo tests use an isolated transport adapter.
No real network demo was run.

Gitleaks found no secrets in the utility files and generated JavaScript.
The documentation changes were checked against source behavior and project writing rules.
These checks do not establish full ASD-STE100 vocabulary conformance.

### npm artifact checks

The checked archive contains `rehistory@2.3.3` and 11 expected files.
Each archived file matches the corresponding source or generated file.
The CLI mode is `0755`. Other archived files use `0644`.
The package has no runtime dependencies or installation hooks.
The existing `prepack` hook builds the six runtime modules.

All six generated modules passed Node.js 24.12.0 syntax checks.
The archived CLI passed its help check on that Node.js version.
Offline npm exec ran help and a JSON audit from a different directory.
The synthetic audit repository remained byte-for-byte unchanged.
The built export implementation accepted a valid export and rejected an unexpected nested file.
The source and rejected export remained unchanged during those checks.

The archive SHA-512 integrity value is:

```text
sha512-3b6PXEYz6UQ1o0SiqXkWYLOKe8Df4iFkDhGNSTMhGMMRfewTYvdHkHAwzjfXFcHb1ubl5+Fzccz4vra99BoTfQ==
```

These artifact checks used empty npm config files, a dedicated cache, and offline mode.
They did not use npm account authentication.
Any later package or included-file change requires a new archive check.

## Remaining limits

- Verification checks structural and policy consistency. It does not prove the actual time of development.
- File contents, messages, names, and selected identities can still contain personal data.
- The manifest is unsigned. Coordinated changes to objects and the manifest are outside its authenticity guarantee.
- The strict export profile can reject metadata from ordinary Git maintenance. The verifier does not remove those files automatically.
- Git calls have no timeout. Large repositories can exceed memory or output limits.
- A trusted local executable, supported Git, and exclusive filesystem access remain necessary.
- Windows and Linux were not tested natively during this review.
- No registry publication, registry ownership check, or real remote push was performed.

The review provides evidence for the checked cases. It is not a security certificate.
