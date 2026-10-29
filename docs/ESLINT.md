# ESLint rules for CLI applications

The shared configuration is [configs/eslint.config.mjs](../configs/eslint.config.mjs).
The root discovery file supplies these rules to application commands.
Prettier runs separately. Its existing configuration and exclusions remain applicable.

The reference is the [anarchy-engine configuration](https://github.com/se-panfilov/anarchy-engine/tree/6f7a661038a088fca48ce4e52d04d30e418f5648/configs/EsLint).
The inspected revision is `6f7a661038a088fca48ce4e52d04d30e418f5648`.
The reference repository uses the [MIT license](https://github.com/se-panfilov/anarchy-engine/blob/6f7a661038a088fca48ce4e52d04d30e418f5648/LICENSE).
Toolchain adapts selected rule settings. It does not execute or install the reference repository.

## Rule selection

| Reference setting                                                 | Toolchain setting                               | Reason                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Recommended JavaScript and TypeScript rules                       | Retained                                        | Keep the existing baseline.                                                            |
| `consistent-return`, `no-useless-computed-key`                    | Enabled                                         | Keep returns and property definitions consistent.                                      |
| `no-useless-assignment` disabled                                  | Keep the recommended setting                    | Do not remove an existing check without a project requirement.                         |
| Getter and setter restrictions                                    | Ban setters. Permit getters.                    | The interruption result reads state after queued signals arrive.                       |
| `explicit-function-return-type`                                   | Enabled with `allowExpressions`                 | Give functions explicit contracts. Permit inferred inline callbacks.                   |
| `no-misused-spread`                                               | Enabled for application TypeScript              | Check spread with actual types, including tests.                                       |
| `consistent-type-imports`, `consistent-type-exports`              | Enabled                                         | Keep type dependencies separate from runtime dependencies.                             |
| `no-unused-vars`                                                  | Add the destructured-array underscore exception | Retain the existing parameter and caught-error exceptions.                             |
| Type alias naming                                                 | Require PascalCase. Omit the `T` prefix.        | Preserve the established application terminology.                                      |
| `no-explicit-any` disabled                                        | Keep it enabled                                 | External data must use `unknown` and validation.                                       |
| `no-inferrable-types`, `restrict-template-expressions` disabled   | Keep the recommended baseline                   | These disabled settings add no new checks.                                             |
| `simple-import-sort/imports`, `simple-import-sort/exports`        | Enabled                                         | Keep import and export order consistent.                                               |
| Internal alias restrictions                                       | Require `@reHistory/*` for runtime modules      | Reject self-package and relative runtime imports. Permit relative test fixtures.       |
| `functional/functional-parameters`                                | Reject `arguments` through a core selector      | Permit rest parameters and any parameter count without another plugin.                 |
| `functional/immutable-data`                                       | Excluded                                        | CLI code changes buffers, TTY state, arrays, environment variables, and fixture state. |
| `functional/readonly-type` generic style                          | Excluded                                        | Preserve the existing TypeScript array notation.                                       |
| Disabled and deprecated functional rules                          | Excluded                                        | Do not add a plugin for inactive checks.                                               |
| `custom/object-assign-max-args`                                   | Core selectors limit calls to two arguments     | Avoid another plugin. Also check literal computed property access.                     |
| `sort-export-all` plugin                                          | Excluded                                        | The reference enables no rule from this plugin.                                        |
| Browser globals, Vue settings, engine aliases and lodash guidance | Excluded                                        | These settings do not describe Toolchain's Node.js applications.                       |
| Spellcheck and its compatibility adapter                          | Excluded                                        | The task excludes spellcheck. Russian interface text remains valid.                    |
| ts-morph and related build checks                                 | Excluded                                        | They are separate engine tools, not ESLint requirements for this project.              |

Type-aware rules use `projectService` and the application's maintained tsconfig.json.
The configuration anchors project discovery to the repository root.
JavaScript configuration files and repository skill fixtures use syntax checks without a TypeScript project.
Generated output, dependencies, coverage, reports, and vendored agent files remain excluded.
When an application adds another internal alias, update its import restrictions and their tests.

The Object.assign selectors check direct static calls. They do not follow aliases or dynamic property names.
These style checks do not establish an execution or data access boundary.
The configuration does not disable inline comments. Review rule suppression as part of code review.

## Migration changes

Imports were sorted in source, tests, and maintained configuration files.
Type-only imports now use explicit type markers.
Functions and fixture helpers received explicit return types.
Named reports describe audit, export, argument, demo, and terminal-style results.
The packed-refs parser now returns `undefined` explicitly on rejected input.
Its accepted inputs and rejection behavior remain unchanged.

The migration adds one pinned development dependency: eslint-plugin-simple-import-sort 14.0.0.
It has no runtime dependencies or installation scripts.
Installation uses the root lockfile and npm ci --ignore-scripts.
The application has no new runtime dependency.

## Repository formatting commands

The [formatting helper](../scripts/format-changed.mjs) uses Node.js and the existing Prettier dependency.
It replaces shell word splitting and the undeclared pretty-quick command.
The clean:reinstall command now runs npm ci --ignore-scripts directly.
It replaces installed dependencies without changing the lockfile or running installation scripts.

| Command                               | Selection and effect                                              |
| ------------------------------------- | ----------------------------------------------------------------- |
| `npm run prettier:changed -- --check` | Check tracked changes against HEAD without formatting writes.     |
| `npm run prettier:changed`            | Format tracked changes against HEAD.                              |
| `npm run pretty-quick -- --check`     | Check staged files without formatting writes.                     |
| `npm run pretty-quick`                | Format staged files in the working tree. Do not update the index. |

Untracked and deleted files are not selected.
The helper uses the root .prettierignore and skips unsupported file types.
NUL-separated Git output preserves spaces and line breaks in filenames.
Subprocess argument arrays and absolute paths prevent filename option injection.
The helper rejects invalid UTF-8, file links, linked parent directories, and partly staged files in staged mode.
It removes inherited Git routing variables and disables external diff commands, text conversion, hooks, and filesystem monitoring.
It rejects configured Git content filters before diff and excludes submodule content.
It checks file identity and modification metadata again before each formatter batch.
Subprocesses have a 60-second timeout and a 16 MiB output limit.
Each formatter batch contains at most 100 files.

Before writes, save uncommitted content that you must recover exactly.
Use --check to examine formatting failures without writes.
After formatting, inspect the Git diff before staging changes.
Recover from saved content or the relevant commit if necessary.
The helper does not make a backup, stage changes, or remove user files.

Trusted PATH entries, repository configuration, dependencies, and exclusive filesystem access remain necessary.
Prettier can execute trusted configuration and plugin code.
The checks cannot prevent a hostile process from replacing a path after validation.
Formatting is not transactional. An error can leave earlier files formatted.
The check mode can read local configuration and dependency files but does not format or stage target files.

## Verification

Run these commands from the repository root:

```sh
npm run format:check
npm run lint
npm run lint --workspace tx-rehistory
npm test
node apps/reHistory/dist/src/cli.js --help
```

The test command checks TypeScript, builds with Vite, and runs all application tests.
The [configuration tests](../apps/reHistory/test/lint.test.mjs) check rejected patterns and permitted CLI behavior.
They also check project discovery from the application directory, Node.js globals, and ignored files.
The earlier data-loss, environment, filesystem, export, signal, and subprocess regressions remain in the suite.

### Completed checks on 2026-10-29

| Environment                             | Final result                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| macOS, Node.js 26.5.1, Apple Git 2.39.5 | TypeScript, Vite, and 149 tests passed. One Linux-specific test was skipped. |
| macOS, Node.js 24.12.0, Git 2.56.0      | TypeScript, Vite, and 149 tests passed. One Linux-specific test was skipped. |

Root formatting and ESLint checks passed. Application ESLint also passed.
The baseline suite passed 129 tests before the migration.
The final suite adds nine ESLint tests and twelve formatting-helper tests.
The invalid-UTF-8 filename test requires Linux and was not executed on macOS.
Native Windows and Linux results remain subject to CI.

An additional full-suite attempt on Node.js 24.12.0 with Apple Git 2.39.5 stalled in a hash-object fixture.
That attempt was stopped. No complete-suite pass is claimed for that environment pair.
The same Node.js version passed with Git 2.56.0.

npm audit reported zero known vulnerabilities in the installed dependency tree.
This result does not prove the absence of dependency defects.
The actual archive contained the twelve allowed files and an executable CLI entry point.
Offline installation outside the source tree passed help, read-only audit, export, and read-only export verification on both tested Node.js versions.
Negative archive checks rejected an unexpected file and preserved source and export bytes.
Both Node.js versions produced this archive integrity value:

```text
sha512-D0JAPHLnICdlujzENZh5V0ZFYkHgU0g1FsRZ/DWqHrqAELieGUYvvRUmh10j/Wt8XxzmhFqQs5oYF9I92okCcQ==
```

No network demo, npm publication, or destructive operation on a personal repository was executed.

## Security review

The review covers lint configuration, dependency metadata, source changes, and distribution boundaries.
The reference configuration was inspected as data. No reference script or installation hook was executed.
Import order and type markers require review because module evaluation can have side effects.
The runtime modules retain their validation, filesystem checks, subprocess arguments, and network confirmation paths.
The dynamic interruption getter remains intact.
After type erasure, all seven runtime modules retained the same executable statements as revision d1390f5.
The comparison normalized explicit undefined returns and compared module dependencies separately from import order.
Import evaluation order was also reviewed. The changed imports introduce no new module or initialization effect.

The review found and fixed a false rejection of metadata properties named arguments.
The regression covers ordinary property access and TypeScript property definitions.
The review also found shell filename splitting and missing commands in the optional root helpers.
The Node.js helper and direct npm ci command replace those failure paths.
Tests cover filename boundaries, option-like names, partial staging, file links, parent links, and Git routing variables.
The security pass identified Git content filters as another execution path before formatting.
The helper now rejects these filters before diff. A regression verifies that a configured clean command does not run.
An isolated dependency-free fixture verifies that clean:reinstall does not execute lifecycle scripts.

Known limits include trusted development dependencies and exclusive access during application writes.
Rule checks do not prove runtime safety or full ASD-STE100 conformance.
Native platform support requires execution on that platform.
