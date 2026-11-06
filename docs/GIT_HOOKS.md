# Git hooks and secret checks

Toolchain uses Lefthook 2.2.2 as a root development dependency.
The [configuration](../lefthook.yml) runs pre-commit checks in parallel.
It checks formatting and secrets without automatic fixes, staging, or stashing.
Hook commands do not substitute filenames into a shell command.

## Trusted configuration sources

The [.gitleaks.toml](../.gitleaks.toml) extends the official rules embedded in Gitleaks with `useDefault = true`.
This is the extension method in the [official configuration guide](https://github.com/gitleaks/gitleaks#configuration).
The official [default configuration](https://github.com/gitleaks/gitleaks/blob/v8.30.1/config/gitleaks.toml) supplies the rules and standard exceptions.
Toolchain adds no allowlist, disabled rule, baseline, or fixture exception.
The configuration is deliberately small so that rule updates come from the installed scanner.

Local checks require Gitleaks 8.28.0 or later in the 8.x series.
CI pins [Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1).
Use that version locally when you need the same embedded rules as CI.
The default rules can differ between supported scanner versions.

## Install

Install Gitleaks from the [official installation sources](https://github.com/gitleaks/gitleaks#installing).
On macOS, the documented Homebrew command is `brew install gitleaks`.
For other systems, use the official binary release or another documented installation method.
The repository does not download or update the local scanner automatically.

Run these commands from the repository root:

```sh
npm ci --ignore-scripts
gitleaks version
npm run hooks:check
npm run hooks:install
```

Lefthook's package has a postinstall script. npm ci --ignore-scripts deliberately prevents that script from running.
Platform-specific optional packages supply the Lefthook binary without a download hook.
Do not add a prepare or postinstall script to install repository hooks.

The explicit installer writes only the pre-commit hook in the common Git directory.
It refuses an existing pre-commit hook, configured core.hooksPath, or linked hooks directory.
An explicitly empty core.hooksPath is also preserved.
It does not overwrite a personal hook or change Git configuration.
If installation stops, inspect the existing setup and combine the checks manually if necessary.
Do not use --force to bypass this review.

The installed hook calls the root npm dependency, not an unpinned global Lefthook binary.
Normal dependency reinstalls do not require replacing the hook.
To remove this integration, inspect the installed pre-commit file first.
Remove only the wrapper installed for this project, or restore the hook you saved before a manual replacement.
Do not remove other hooks.

## Local checks

| Command                           | Scope                                                                       |
| --------------------------------- | --------------------------------------------------------------------------- |
| `npm run hooks:check`             | Validate lefthook.yml.                                                      |
| `npm run test:hooks`              | Run isolated hook and scanner integration tests. Requires Gitleaks.         |
| `npm run gitleaks:staged`         | Scan added lines in the staged Git diff.                                    |
| `npm run gitleaks:history`        | Scan complete history reachable from all local refs. Refuse shallow clones. |
| `npm run gitleaks:files`          | Scan working files, including untracked files and files ignored by Git.     |
| `npm run pretty-quick -- --check` | Check formatting of staged files without writes.                            |

Pre-commit runs the staged formatting and secret checks in parallel.
Formatting errors do not trigger automatic writes or git add.
Partly staged files stop the formatting check. Separate those changes before the commit.
Both checks respect Git's temporary GIT_INDEX_FILE during commit --only and commit --all.
Other inherited Git routing variables are removed so that they cannot select another repository.

The scanner requires the selected repository root and its explicit .gitleaks.toml.
It ignores GITLEAKS_CONFIG, inline gitleaks:allow comments, and .gitleaksignore fingerprints.
Git content filters and external diff drivers are rejected before scanning.
Git hooks, filesystem monitoring, global configuration, and replacement objects are disabled for scanner subprocesses.
The commands do not fetch, push, or change Git refs.

A possible secret returns status 1. An incomplete check returns status 2.
Console output lists only the count and rule identifiers. It does not include source excerpts, filenames, or secret values.
Prettier failures also omit raw source diagnostics in the formatting helper.
For local investigation, inspect your own staged diff without sharing it in logs or reports.
The upstream CLI can also display findings with --redact=100. Treat its file and commit metadata as private information.

The wrapper creates a redacted JSON report in a private temporary directory with file mode 0600.
It removes the report after normal success or failure.
Forced termination can leave the private temporary directory.
Scanner subprocesses have a five-minute timeout and a 4 MiB console-output limit.
The wrapper refuses to read a report larger than 64 MiB.
That limit does not bound the scanner's initial report writes or its total memory use.

## CI

The [Secrets workflow](../.github/workflows/secrets.yml) has read-only repository permission.
Checkout retrieves complete history and does not retain GitHub credentials in Git configuration.
The job downloads the official Gitleaks 8.30.1 Linux x64 archive and checks this SHA-256 before extraction:

```text
551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
```

The checksum is recorded in the official release metadata.
The download has a 60-second timeout and a 32 MiB limit.
Only the gitleaks executable is extracted into a new runner temporary directory.
The job then validates Lefthook, runs integration tests, scans history, and scans working files.
It does not use a pull-request-target event, publish findings, or upload scan reports.

## Security review and limits

Tests use synthetic credentials constructed at runtime in isolated repositories.
They cover staged-only changes, temporary indexes, deleted secrets on another branch, inline suppressions, and ignored working files.
Real Git commits exercise the installed Lefthook wrapper.
Other tests preserve existing hooks and configuration, reject a linked hooks directory, and verify that external Git drivers do not run.

The security review reproduced a textconv bypass in Gitleaks staged mode.
A configured driver could replace a staged secret with clean output and execute an external command.
The wrapper now rejects diff._.textconv, diff._.command, and diff.external before scanning.
The regression first reproduced a false success, then verified refusal without command execution.

Another regression reproduced secret exposure in Prettier's syntax-error excerpt.
The formatting helper now returns a short error without forwarding raw diagnostics.
The installer also checks the literal hooks path because Git can resolve a directory link before a later path check.

Git, Gitleaks, Lefthook, PATH entries, repository configuration, and installed development dependencies remain trusted.
Gitleaks inherits upstream exceptions, including some binary formats, dependency files, and its configuration file.
Directory scans do not follow file links. Archive traversal and recursive decoding are not enabled.
History scans cover reachable local refs, not reflogs, unreachable objects, or remote branches absent from the clone.
Secret detection can have false positives and false negatives.
Review changes to configuration and dependency versions.

Local hooks can be bypassed with Git or Lefthook controls.
CI provides a separate check. Required-check branch protection must be configured separately by the repository owner.
No branch protection, remote setting, or publication permission is changed by this integration.
Hook installation requires exclusive access while checking and writing hook paths.
Path checks do not prevent a hostile same-user process from replacing files after validation.

## Verification record

Local checks ran on macOS on 2026-10-29.
All fourteen hook integration tests passed with Node.js 26.5.1 and Gitleaks 8.28.0.
The same tests passed with Node.js 24.12.0 and Gitleaks 8.30.1.
Both runs used Lefthook 2.2.2.
The official macOS 8.30.1 archive was checked against its release SHA-256 before execution.

Formatting, ESLint, and Lefthook validation passed.
The root application check passed TypeScript, Vite, and 149 tests. One Linux-specific test was skipped on macOS.
History and working-file scans passed with Gitleaks 8.28.0 and 8.30.1.
npm audit reported zero known vulnerabilities in the dependency tree.
An independent security review reproduced the textconv bypass and verified its fix with the regression test.
The pre-commit hook was installed in the current checkout after the isolated installation tests passed.

Native Linux and Windows hook execution was not tested locally.
The new Linux CI job must provide its own execution result after the branch is pushed.
Application runtime source, version, and npm archive contents are unaffected by these repository-only changes.
The task branch includes the current master changes. Its application version and three application workflows are preserved.
