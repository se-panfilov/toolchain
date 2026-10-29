# Application directory, versions, and test execution

Change date: 2026-10-29.

## Application layout

The application directory is now `apps/reHistory`.
Future applications belong under `apps/` and retain the `tx-<lowercase-directory-name>` naming rule.
Agent instructions, the local CLI skill, CI paths, metadata, help, and documentation use the new directory.
The npm package and CLI command remain `tx-rehistory`.

The CLAUDE.md and GEMINI.md adapters still refer to AGENTS.md.
Their requirements therefore include the updated application directory and version policy.
Unrelated upstream examples and npm registry terminology retain the word packages.

## Version policy

[AGENTS.md](../AGENTS.md) and [the package requirements](PACKAGES.md#version-policy) require one SemVer update per changed application and iteration.
Compatible fixes and optimizations use a patch increment.
Compatible features use a minor increment.
Incompatible public contract changes use a major increment.

This iteration changes layout, metadata, development commands, and test scheduling without changing the installed CLI contract.
The selected increment is patch, from 2.4.1 to 2.4.2.
The executed command was:

```sh
npm version patch --no-git-tag-version --ignore-scripts --prefix apps/reHistory
```

The manifest and both lockfile version fields match.
Version strings were not edited directly.
The command did not create Git commits or tags and did not run version lifecycle scripts.

## Test measurements

The measurements used the same macOS host, Node.js 26.5.1, and system Git 2.39.5.
The host reported eight available CPUs.
Each command included the mandatory TypeScript check and Vite build.
The results are individual local measurements, not statistical benchmarks or CI guarantees.

| Configuration                           | Complete npm test time | Result     |
| --------------------------------------- | ---------------------- | ---------- |
| Original sequential files               | 46.87 seconds          | 119 passed |
| Three-worker experiment before the move | 18.92 seconds          | 119 passed |
| Final configuration after the move      | 19.05 seconds          | 119 passed |

The final run reduced elapsed time by approximately 59%, or a factor of 2.46.
Assertion names and statuses matched the original JSON report exactly.
No test was removed, skipped, or replaced with a mocked success path.
The 257 MiB export, signal, lock, environment, atomic push, and build failure regressions remain included.

Files run in isolated fork processes with at most three workers.
Available CPU parallelism limits the worker count.
Tests within a file remain sequential because some cases change process state.
Temporary repository fixtures remain independent.

The check command no longer runs a separate duplicate TypeScript check.
Its mandatory build still invokes TypeScript before Vite and test execution.
The build script and its failure protections were not weakened.

For serial diagnosis, run:

```sh
npm --prefix apps/reHistory test -- --no-file-parallelism --maxWorkers=1
```

## Security and verification

The separate review examined path selection, aliases, CI paths, package metadata, worker isolation, fixtures, and version command effects.
The runtime change is limited to the help example path.
Git environment controls, object validation, filesystem checks, transactions, network policy, and confirmation defaults are unchanged.

The worker limit bounds default CPU and process pressure.
Parallel execution can increase peak memory and disk activity compared with serial execution.
Use fewer workers on constrained systems.
Native Windows and Linux timing was not measured locally.

- Node.js 24.12.0: `npm run check` passed all 119 tests, mandatory type checking, lint, and formatting checks in 20.15 seconds.
- Node.js 26.5.1: the complete npm test passed all 119 unchanged assertions in 19.05 seconds.
- Maintained local Markdown links resolve, and application references use the new directory.
- The manifest and lockfile both identify version 2.4.2.
- The actual archive contains exactly 12 allowed regular files, including seven runtime modules.
- The bin has mode `0755`; other members have mode `0644`.
- Archived modules passed Node.js 24 syntax checks.
- Offline npm execution from another directory passed help and audit checks.
- Compiled archive export and negative verification passed without changing the source fixture.
- Gitleaks found no secrets in the extracted archive.
- Prettier, ESLint, and `git diff --check` passed.
- No publication, real network demo, Git commit, branch, or tag was created by the agent.

Archive integrity:

```text
sha512-6nHcQK3oWx16zY4V2KPO1qma4O9Y/5VbBHsv/wyKaqlLHlNnIXCZkI2SBX/1uoPBwh72StJLQvP8Px/Dt6Qu5g==
```
