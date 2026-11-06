# External audit assessment and corrections

Review date: 2026-10-29.

## Scope

This review assessed eight external findings against the reHistory implementation.
The Toolchain CLI workflow guided implementation and separate security checks.
Tests used isolated synthetic repositories without real network pushes.
Repository changes made or staged by the user were preserved.

The review covered all seven runtime modules, Git subprocess boundaries, temporary packs, build output, CI configuration, and the npm archive.
Source history and blame established the earlier Git environment and ref transaction controls.
No runtime dependency was added.

## Findings and decisions

| Item                            | Assessment                                                                                                                          | Correction                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Windows executable discovery | The concern is supported by libuv source. A native exploit was not reproduced on macOS.                                             | Resolve Git once from absolute PATH directories. Ignore empty, relative, and drive-relative entries. Launch the absolute executable from its installation directory. Add a native Windows CI fixture with a committed `git.exe`. |
| 2. URL-specific TLS overrides   | Confirmed on Git 2.56.0. URL-specific `sslVerify=false` overrides the general command option.                                       | Reject all local `http.*` keys before network access. Repeat the guard inside the shared adapter. Keep URL substitutions blocked.                                                                                                |
| 3. Status filters               | Valid execution boundary. Parent status can also inspect initialized nested submodules.                                             | Reject clean, process, and smudge configurations before status, including nested submodules. Keep the read-only audit independent of status. Document Git LFS restrictions.                                                      |
| 4. JSON terminal controls       | Valid defensive correction. Normal JSON serialization does not escape all C1 and Unicode format controls.                           | Escape these characters after serialization, including supplementary code points. Preserve values after JSON parsing. A replacer that returns literal escape strings would change the parsed values.                             |
| 5. Invalid object compatibility | The NUL fixture depended on malformed commit data. It did not demonstrate failure for ordinary valid history.                       | Reject selected NUL metadata before writes. Preserve other binary message bytes. Import generated metadata with strict Git validation. Test the minimum Git family and pinned modern Git.                                        |
| 6. Processes and blob buffers   | Confirmed performance and resource limits. The former export captured complete blobs in Node.js buffers.                            | Batch commit reads, audit reads, and commit verification. Compute new object IDs in Node.js. Import generated metadata as one pack. Transfer content through a private temporary pack file.                                      |
| 7. Remaining locks              | Valid reliability issue. No cleanup can survive every forced termination or power loss.                                             | Report the lock PID and recovery procedure. Defer parent SIGINT during local application so cleanup can run. Keep stale lock removal manual.                                                                                     |
| 8. HTTPS authentication         | Valid usability concern under the deliberate authentication policy. HTTPS itself can work for permitted unauthenticated operations. | State that authenticated GitHub and GitLab writes require SSH. Keep helpers, askpass programs, URL credentials, and interactive login disabled.                                                                                  |

The external test used Node.js 22, outside the package engine requirement.
The replacement checks use supported Node.js versions.
The external results remain useful evidence but do not establish supported-runtime compatibility.

## Additional corrections from the security pass

Git 2.56.0 creates reverse-index files during pack import by default.
The export format permits pack and idx files only.
The Git wrapper disables reverse-index creation instead of widening the verifier allowlist.

Config key inspection uses NUL-separated name-only records.
Multiline values cannot masquerade as additional keys.
Partial clones are rejected before working-tree and submodule inspection.

Temporary pack descriptors are cleared after closure and reopened for reading.
The private temporary directories are removed after normal completion and handled errors.
A forced termination can leave those directories.

## Security boundaries reviewed

- Executable resolution does not use an implicit current-directory search.
- Repository selection remains an absolute Git `-C` argument.
- Git receives argument arrays without shell interpolation.
- Network guards reject HTTP configuration overrides before connection attempts.
- Filter checks precede recursive status and do not execute filter commands.
- Metadata batches validate object IDs, types, byte lengths, separators, and trailing data.
- Node.js object hashes are checked again before pack creation.
- Git validates imported metadata before the atomic ref transaction.
- Content packs enumerate trees and blobs without source commit traversal or reused delta bases.
- Existing ref comparisons, backup exclusivity, recovery files, and atomic updates remain active.
- Default refusal of push and separate server write confirmation remain active.
- JSON escaping preserves machine-readable values.

The separate pass found no unresolved critical or high-severity defect within the documented trust assumptions.
This is not a formal security certificate or a guarantee against all defects.

## Verification

- Node.js 24.12.0 with Apple Git 2.39.5: `npm run check` passed all 119 tests, TypeScript, ESLint, and Prettier checks.
- Node.js 24.12.0 with Git 2.56.0: the same complete check passed all 119 tests.
- Node.js 26.5.1 with Git 2.56.0: all 22 focused hardening tests passed.
- A 257 MiB blob exported and verified with its original object ID.
- A 131-commit history used two metadata read batches and one metadata pack import.
- Pack size encoding boundaries, SHA-1, SHA-256, filters, HTTP overrides, JSON controls, locks, and SIGINT were checked.
- A real terminal passed dry-run, rewrite, default push refusal, and export checks.
- Byte snapshots confirmed unchanged dry-run data and an unchanged source during export.
- The actual npm archive contained exactly 12 allowed regular files and seven runtime modules.
- The CLI mode was `0755`; other archive files used `0644`.
- All archived modules passed Node.js 24 syntax checks.
- Offline npm execution from another directory passed help and audit checks.
- The compiled archive passed export and negative verification without source changes.
- Gitleaks found no secrets in the extracted archive.
- Prettier parsed and checked the CI YAML and this report.
- `git diff --check` passed.

Archive integrity:

```text
sha512-1ZXB9fdJ/17/Q1FkkCcTrkKbHWltwliCFNmG63/Tiec39cd580xJnbZo4I4ZrVJRJ5IcgP11UoUGgcLxqIl3Ug==
```

## CI configuration

The workflow targets macOS, Linux, and Windows with Node.js 24.12.0 and Node.js 26.
Linux builds pinned Git 2.56.0 from the official source archive after checking SHA-256.
The test build disables optional Rust, curl, OpenSSL, Tcl/Tk, gettext, Perl, and Python components.
Local Git 2.56.0 checks used the same reduced build configuration.
This build validates repository operations and local fixture transport, not authenticated HTTPS connections.

The workflow actions are pinned to verified commit IDs.
Checkout does not retain credentials.
The workflow has read-only contents permission and uses `npm ci --ignore-scripts`.
Local Prettier parsing checked YAML syntax.
GitHub execution, native Windows behavior, and native Linux behavior were not observed in this session.

## Remaining limits

The operating system, process environment, executable directories, Git, Node.js, SSH configuration, and certificate trust store must be trusted.
A hostile local process can change files after the last state check.
A configuration digest is not an isolation boundary against that attacker.

Rewrite and export reject filter repositories, including applicable Git LFS configurations.
Submodule inspection accepts at most 256 working trees and requires UTF-8 index paths.
Captured Git output remains limited to 256 MiB, and generated metadata remains limited to 128 MiB.
Blob transfer also needs temporary disk space and Git memory.
Tag planning and tag target verification still use individual Git calls.
There is no general Git command timeout.

NUL metadata is unsupported.
Other invalid objects can fail strict pack validation before refs change.
An interrupted operation can leave new unreachable objects or recovery files.
SIGKILL, crashes, power loss, and abrupt termination can leave locks and private temporary files.
The program does not remove another process's lock automatically.

No authenticated HTTPS or SSH server was used.
No publication was performed.

## Primary references

- [libuv Windows process search](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c).
- [Git URL-specific HTTP configuration](https://git-scm.com/docs/git-config).
- [Git hash-object validation and literally](https://git-scm.com/docs/git-hash-object).
- [Git pack object selection](https://git-scm.com/docs/git-pack-objects).
- [Git index-pack validation](https://git-scm.com/docs/git-index-pack).
