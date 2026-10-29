# Security checks

Document date: 2026-10-29.
This document gives the security controls and specified limits of reHistory.
It is not a security certificate from another organization.

## Conditions for use

**CAUTION: Use tools and files that you trust.**
The program does not isolate local software or file systems that can attack it.

These conditions are necessary:

- The Node.js and Git executables are correct.
- The operating system and PATH are correct.
- The source config and SSH config are under your control.
- No other process changes the source or export during an operation.

Use [README.md](README.md) for the operating procedures.
Use [TERMINOLOGY.md](TERMINOLOGY.md) for project terms.

## Git command controls

The program gives Git an argument array.
It does not insert user text into a shell command.
The SSH BatchMode command is a constant string.
It contains no user input.

The program removes inherited `GIT_*` variables before a Git call.
It does not read system or global Git config.
It reads local source config.

Command options disable these functions:

- Hooks and fsmonitor.
- Replace objects and automatic signatures.
- Automatic maintenance and garbage collection.
- Network and file transports except through the demo adapter.

Only HTTPS and SSH are available through the demo adapter.
The source does not give remote helpers or a remote URL to other modes.
The audit cannot start a lazy fetch for a missing object.

## Input controls

The program validates branch names with Git.
If there is a backup branch with the selected name, the program stops.
The initial backup name is `rehistory-backup/original`.
It does not contain a date, time, or counter.

Recovery files and backup refs use random UUID v4 values.
These UUID values do not encode the current time.
The program does not change earlier files and refs.
The audit and recovery format also operate with them.

The program validates calendar dates, times, offsets, intervals, names, and email addresses.
It rejects nonexistent local times during daylight saving time changes.
Use a specified offset for an ambiguous local time.

The program removes control characters from displayed user data.
The program adds its own color codes after this step.
JSON output follows a different path without colors.

## Terminal controls

An ANSI terminal with TTY input and output is necessary for interactive changes.
The program rejects `TERM=dumb` before raw mode starts.

The initial answer for permission to write is No.
The initial permission to remove signatures is also No.

Arrow keys move focus without permission to write.
Space selects an answer.
Enter accepts that answer.
Digits cannot give permission to write.
Bracketed paste cannot select or accept an answer.

Input fields contain editable initial values.
An empty field stays empty for validation.
The input fields do not keep a readline history.

Each question removes its event handlers after completion or cancellation.
It restores the initial raw mode and stream state.
Cancellation does not become another date or time question.
The CLI gives exit code `130` for an input cancellation.

## Source protection

The program examines HEAD, refs, the index, and the working tree before a change.
It examines the state again before the ref transaction.
It rejects not complete operations and unsupported source states.
The README lists these states.

The program uses only the exact `refs/codex/` namespace as a service exception.
The similar name `refs/codex-untrusted/` does not give this permission.
Service refs stay with no changes and appear in the audit.
They do not enter the export.
They can keep the initial history in the source.

The program writes a recovery file before new objects.
It makes a new file with POSIX mode `0600`.
It synchronizes the file with `fsync`.
The program does not replace a file or symbolic link at the selected path.

The program writes the selected refs and backup refs in one transaction.
The transaction compares complete old object IDs.
The transaction uses `verify` for unselected direct refs.
It uses `no-deref` to prevent a write through a substituted symbolic ref.
If transaction preparation fails, the refs keep their old values.

The file `rehistory.lock` prevents another reHistory write operation.
Other Git tools do not obey this lock.

**CAUTION: Do not remove an active lock file.**
Use the lock procedure in the README after a process error.

## Object controls

The new commits keep trees, file contents, messages, and parent order.
A parent date is before its child date.
The author date and committer date are equal.

The program changes annotated tag dates and identities only under the selected policy.
Nested tags use their target commit dates.
The program removes invalid signatures and mergetag headers with user permission.
It does not make replacement signatures.

A dry-run does not write objects, refs, directories, lock files, or recovery files.
The byte comparison found no changes to temporary repositories.

## Export controls

The destination must be new and external to the source repository and the common Git directory.
The program does not replace a directory or symbolic link at the destination.
It does not delete a failed destination automatically.

The export contains only selected history objects.
It copies necessary tree and blob contents without a checkout.
It does not copy the source config, source reflog, backup refs, or unrelated objects.
It does not use hard links or alternates.

The manifest contains only new object IDs, refs, and policy data.
It does not record old commit IDs, old tag IDs, or the source path.
The program compares the complete inventory with this manifest.
It examines dates, identities, parent order, and reachability.
It rejects extra refs, config, files, links, and special files.
It also uses `git fsck --full --strict --no-reflogs`.

**CAUTION: Do not publish an export that fails a check.**
A failed export can be not complete.

## Demo controls

A specified network URL is necessary before the demo makes files or uses the network.
It does not make a local server.
It uses generated data in a new source directory.
It does not use the current project as demo input.

The URL validator rejects credentials, unsupported protocols, and unsafe path forms.
The program examines server refs before it makes demo files and before the first push.
It stops if the server advertises a ref.
The probe uses a temporary directory without parent repository config.

Server refs use a unique demo prefix.
The demo uses atomic push and specified refspecs.
It does not use force push, mirror push, or ref deletion.
The program does not send changed history, backup refs, or the export after the initial demo data.

SSH uses BatchMode and the configured host key controls.
HTTPS keeps TLS verification and rejects redirects.
Global Git credential helpers and interactive login are unavailable.

If a push completes before a later error, the program keeps that server data.
The program does not undo completed push operations.
The user controls server cleanup.

## Known limits

- Changed Git dates do not show the time of the work.
- Files, messages, tag names, file timestamps, and submodule histories can contain initial dates.
- Other copies and server records can keep initial data.
- A recovery file without backup refs cannot prevent object loss through garbage collection.
- Another process can change HEAD, refs, or files after the last state check.
- A ref transaction cannot prevent damage from a disk error or a power loss.
- A reader of two or more refs can see an intermediate state.
- The process can stop after writes to objects, recovery files, lock files, or the destination.
- The manifest has no digital signature.
- If someone changes the manifest and data, the export check can give an incorrect result.
- The server can hide refs from the demo probe.
- Atomic push must be available on the server.
- The program does not examine file contents for dates or personal data.

The limit for new commit and tag metadata is 128 MiB.
The limit for one Git response is 256 MiB.
The program keeps the plan in memory.
It starts two or more Git processes for each object.
Large objects or histories can cause an operation to stop.

## Previous implementation checks

An earlier implementation check had 46 of 46 correct test results.
The test platform was macOS with Node.js 26.5.1 and Git 2.39.5.
Selected terminal and date cases also passed with Node.js 24.12.0.

The checks included these subjects:

- Merge graphs, empty commits, binary files, and message bytes.
- Backup conflicts, recovery transactions, and source state changes.
- Dirty trees, stash, shallow clones, partial clones, grafts, and worktrees.
- Service refs and unsupported namespaces.
- SHA-1 and SHA-256 exports.
- Extra refs, objects, config, files, and incorrect tag dates.
- Hooks, Git routing variables, and concurrent reHistory writes.
- Forced terminal colors and JSON output.
- Input defaults, cancellation, paste, raw mode, and color controls.
- Fixed backup names, UUID v4 names, time offsets, and daylight saving time changes.
- Demo URL validation, empty server requirements, and the complete demo sequence.

The demo test used Git pushes through a local test adapter.
A real network server was not part of that test.
Do different tests for authentication and hosting behavior with a specified empty server URL.
Signature tests used synthetic blocks, not complete cryptographic signature generation.

Linux, Windows, and npm publication have no different test results.
The earlier build did not do a TypeScript type check.

## Documentation change controls

This revision changes documentation and code comments.
It keeps the Russian interface text and program instructions with no changes.
The source comparison reverses each comment replacement and compares the initial source text.
The documentation check examines sentence length, links, terminology, and safety instructions.
The English vocabulary check uses the ASD-STE100 Issue 9 dictionary.

A vocabulary check alone does not show correct meaning or part of speech.
Another person has not done an STE language check.


## Checks for this documentation revision

The source comparison confirms 35 comment replacements in ten source files.
Executable instructions and Russian interface strings did not change.

All prose sentences contain at most 20 words under the conservative mechanical count.
All paragraphs contain at most six sentences.
Local document links and package document entries are correct.
The JavaScript build and syntax checks completed without errors.
The package inventory includes the terminology document.

The full implementation test suite was not repeated for comment and documentation changes.
The previous result of 46 tests is the implementation baseline.


## Earlier npx publication procedure checks

These checks used a publication guide that is no longer included.
They describe an earlier package state.

The guide uses a scoped name and the public npm registry.
It uses browser authentication with 2FA instead of a publication token.
It publishes the same archive that passed local npx checks.
It compares archive integrity with the published registry value.
The version command disables npm Git commits and tags.

The local procedure check used a temporary package copy and empty npm config files.
Network access was disabled for all npm checks.
The checks covered scoped metadata, private guard deletion, a version change, the archive, and the executable bin.
A different directory started the bin through offline npm exec.
The Russian help and a read-only audit completed correctly.

The synthetic repository did not change during the audit.
The offline publication dry-run completed without a registry write.
The checks did not use account login or public publication.


## Publication security audit: 2026-10-29

The audit found two defects and added controls for them.
The Git environment filter now removes variable names without case sensitivity.
This prevents mixed-case Git routing variables from passing the filter on Windows.
A platform-independent regression test examines this filter.
A native Windows test is still necessary.

The tag parser now rejects an incomplete signature block.
It also rejects a mismatched end marker or text after a signature.
The previous parser could discard message text after an ambiguous start marker.
The new check stops plan creation before any repository write.
Complete PGP and SSH signature blocks remain available for removal.
Clear-signed message markers stop the operation because their contents are ambiguous.
This check examines block structure, not cryptographic validity.

The package has no runtime dependencies or installation hooks.
The prepack hook builds six specified JavaScript modules.
The archive file allowlist excludes source tests, Git data, credentials, and local editor files.

Git calls have no time limit.
A server or local Git command can therefore stop an operation from completing.
Large repositories can also exceed the response or memory limits.
These limits remain applicable to publication.

## Review with project skills: 2026-10-29

The review used the Toolchain workflow, sharp edges analysis, differential review, property testing guidance, and code simplification guidance.
An independent review used only temporary synthetic repositories.
No network demo, npm publication, or change to Toolchain Git refs was performed.

The review found these defects:

- The export check accepted unexpected files inside allowed directories.
- Git-ignored metadata in config and packed refs could pass the previous checks.
- Dangling loose symbolic refs were omitted by Git and absent from the audit.
- Multiple signature blocks could cause tag message text to be discarded.
- Cached peeled tag targets and pack filenames could retain unrelated object IDs.

The fixes add these controls:

- A strict manifest schema rejects unknown fields, duplicate entries, mixed hash widths, and invalid identities.
- File checks cover nested directories before Git reads the object store.
- Only expected loose objects, refs, metadata, and minimal pack/idx pairs are accepted.
- Metadata comments, unknown header words, unsupported values, and duplicate config keys are rejected.
- Pack and index names must match their embedded pack checksums.
- Cached peeled targets must occur in the manifest and match actual tag targets.
- Omitted loose symbolic refs appear in the audit and block local branch or tag rewriting.
- Signature removal accepts one complete trailing armor block and preserves message bytes before it.

The new tests include 1024 deterministic binary-message and signature combinations.
They check byte preservation, idempotence, and unchanged input buffers.
They do not add a property testing dependency or automatic shrinking.
The malformed-input tests cover unknown metadata, invalid types, duplicate entries, and signature ambiguity.
SHA-1 and SHA-256 tests cover packed exports and cached peeled targets.

The strict file profile can reject metadata created by ordinary Git maintenance.
The verifier does not remove that metadata automatically.
It does not inspect file contents for personal data or prove the actual time of work.
The previous trust conditions and unsigned-manifest limitation still apply.

The complete suite passed all 55 tests on Node.js 24.12.0 and 26.5.1 on macOS.
The tests used synthetic repositories, including the isolated demo transport adapter.
Gitleaks found no secrets in the utility files and generated JavaScript.
This scan does not prove that all sensitive data is absent.

## Compiled runtime migration

Local startup and the npm bin now use the same `dist/src/cli.js` entry point.
The local start command builds before it starts the application.
A compiler error stops startup instead of executing stale output.
Direct `node dist/src/cli.js` execution uses the last successful build.
Rebuild after source changes.

The build uses strict TypeScript checks with noEmitOnError and NodeNext module resolution.
It compiles into a new temporary directory before updating `dist/`.
The temporary directory is removed after success or failure.
Output checks reject symbolic links, hard links, and special files at expected output paths.
The checks run before and after compilation.
Exclusive filesystem access remains necessary during output writes.
A filesystem error during publication of compiled files can leave a partial build.
The start command stops on this failure. Rebuild successfully before direct execution.

TypeScript 5.9.3 and Node.js types 24.10.1 are exact development dependencies.
The lockfile also pins undici-types 7.16.0 and records archive integrity values.
These three packages have no installation hooks.
They are not runtime dependencies and do not enter the publication allowlist.
The dependency audit reported no known vulnerabilities for this locked tree.
This result does not prove the absence of dependency defects.

The build regression tests use isolated copies.
They check that a type error preserves stale output and prevents its execution through npm start.
They also check output directory links, output file links, and hard links.

All 57 tests passed on Node.js 24.12.0 on macOS after this migration.
The two build regression tests also passed on Node.js 26.5.1.
A clean offline npm ci completed with installation scripts disabled.
Its compiled runtime files matched the local build byte-for-byte.

## Package layout and private imports

Runtime source, tests, and build tools now have separate directories.
The publication allowlist contains only six runtime modules and the required package documents.
The npm bin and local start command use `dist/src/cli.js`.
Private imports map `#rehistory/*` directly to compiled modules inside the same package.
The compiler has corresponding source mappings. Runtime execution does not use source files or custom loaders.
The empty exports map identifies this package as a CLI without a public import API.
It does not prevent direct filesystem access to package files.

The build checks nested output directories before writes.
It rejects unknown files instead of removing them.
After successful compilation, it removes only known flat files from the earlier generated layout.
The existing exclusive-access and partial-output failure limits remain applicable.

All 58 tests passed on Node.js 24.12.0 after the layout and import changes.
The three build safety tests also passed on Node.js 26.5.1.
These include nested directory links and preservation of unknown output files.
