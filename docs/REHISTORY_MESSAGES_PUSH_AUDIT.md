# Commit message and optional push review

Review date: 2026-10-29.

## Scope and method

This review covers the working-tree changes for commit message replacement and optional final push.
The review used the Toolchain CLI workflow and the differential-review method.
Implementation checks and a separate security pass examined inputs, subprocesses, local writes, server writes, cancellation, and distribution.
Read-only Git history and blame established the environment-isolation baseline.
No Toolchain commits, branches, tags, staging operations, or real server pushes were made.

The affected production call paths are:

- CLI and demo call `makePlan`.
- CLI and demo call the export engine.
- Only the normal CLI completion path calls `preparePush` and `executePush`.
- The normal push and demo transports have four `networkGit` call sites in total.
- Export loading, export checking, plan creation, and the CLI call the message validator.
- The existing Boolean confirmation API uses the new single-choice selection implementation.

The shared network adapter extends the review scope to demo URL validation and authentication.
The build configuration, build fixture, and package file allowlist include the seventh runtime module.

## Protected behavior

Message replacement is initially disabled.
When selected, all commits in the chosen history receive the same UTF-8 message.
Tag messages, other branches, trees, and parent order retain their previous behavior.
The export manifest records the policy, and verification checks the message bytes.
The message validator rejects empty text, hidden controls, and input larger than 64 KiB.

Push is initially disabled and follows successful local rewriting only.
There is no push question after a dry-run, export, audit, or demo.
The first confirmation permits server inspection.
A separate confirmation permits server writes after the destination and ref list are shown.

The push uses exact object IDs, explicit per-ref leases, and atomic updates.
Its scope contains only the current branch destination and selected tags.
Backup refs, other branches, automatic tag following, submodule pushes, and mirror mode are excluded.
Unknown server history stops preparation.
A server race or missing atomic capability stops the complete push without an unsafe fallback.

Local refs and the effective configuration digest are checked before transmission.
URL substitutions, multiple push URLs, and multiple upstream branches are rejected.
Credential helpers, askpass programs, hooks, inherited push options, and push negotiation are disabled.
Only explicit HTTPS and SSH transports can use the network adapter.
TLS checks remain enabled, and HTTP redirects are disabled.

## Findings fixed before delivery

| Finding                                                                                      | Effect                                                               | Correction and evidence                                                                                |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A replacement could inherit an old `encoding` header.                                        | Git could display the UTF-8 replacement incorrectly.                 | Remove the header only for replacement; test display and reject the header during export verification. |
| SCP conversion changed a home-relative path into an absolute SSH URL path.                   | The connection could select a different repository on an SSH server. | Preserve SCP syntax; add URL regression assertions.                                                    |
| URL parsing could normalize dot segments before validation.                                  | An ambiguous input could select a different path.                    | Reject raw parent segments, percent escapes, and backslashes before URL parsing.                       |
| Local credential or askpass configuration could execute a client program during network use. | Server inspection could start an unreviewed helper.                  | Clear helpers and askpass controls in the shared network adapter; assert arguments and environment.    |
| A generic cancellation message could imply that a completed rewrite was undone.              | The user could misread local state after cancelling optional push.   | Handle cancellation at the push boundary and report that local history remains saved.                  |

The completed review found no unresolved critical or high-severity defect within the stated trust boundary.
This result is not a guarantee against all defects.

## Executed checks

- Node.js 24.12.0: `npm run check` passed all 97 Vitest tests, TypeScript, ESLint, and Prettier checks.
- Node.js 26.5.1: all 27 focused network, message, and terminal selection tests passed.
- Gitleaks found no secrets in the extracted npm archive.
- SHA-1 and SHA-256 fixtures checked message replacement, export policy verification, and atomic push scope.
- Negative tests checked branch and tag races, unknown server history, malformed advertisements, URL ambiguity, local changes, and disabled atomic support.
- Hook and push configuration fixtures checked that unrelated refs and backup branches were not transmitted.
- A real terminal checked message input, unchanged dry-run bytes, local rewrite, default refusal of push, and export verification.
- The terminal fixture used an unusable `ext::` remote; default refusal did not attempt transport preparation.
- The actual npm archive contained 12 allowed regular files, including seven runtime modules.
- The archive bin had mode `0755`; other members had mode `0644`.
- All archived modules passed Node.js 24 syntax checks.
- Offline `npm exec` from another directory passed help and audit checks.
- The compiled archive passed export verification and a negative extra-file test without changing the source fixture.
- No dependency was added or changed by this feature.

Archive integrity:

```text
sha512-Gb0eByw+dUeK2ZS913sOWg7R+6nEbea/zZXMhjBeqPLsxRiMBOKfIjfBDP8aryBE1Bv+kpRqHKECgOysrp4pjw==
```

## Residual limits

SSH configuration, SSH keys, PATH, Node.js, Git, and the operating system must be trusted.
Credential helpers are disabled; an existing SSH key or agent is the normal authenticated transport.
A real HTTPS or SSH server was not used for these tests.
Server protections and authentication can reject a push.
Only macOS was exercised.

Configuration checks do not isolate the process from hostile local file-system changes after the final check.
Stop concurrent Git and configuration operations before use.
Network commands can wait on remote infrastructure.
A lost response can leave the server result uncertain; inspect the server before retrying.
A push failure or cancellation does not undo the local rewrite.

Push does not erase server objects, backups, remote-tracking refs, unrelated refs, or other clones.
Git LFS hooks are disabled; external LFS objects require a separate transfer.
Files, tag messages, names, and submodule histories can retain dates and personal data.
The export manifest is unsigned and does not prove the absence of that data.
