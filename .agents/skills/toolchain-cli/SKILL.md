---
name: toolchain-cli
description: Develop and audit Toolchain CLI utilities. Use for CLI implementation, security reviews, and npx preparation in this repository.
---

# Develop and audit a Toolchain CLI

Read [AGENTS.md](../../../AGENTS.md) before using this workflow.
That file contains the project requirements and authorization limits.
This skill does not grant permission to publish, push, or change real user data.

## Establish the change

1. Read the selected utility's source, README, security notes, and package scripts.
2. Identify the affected behavior and the user's expected result.
3. Identify target data, input sources, writes, subprocesses, and network effects.
4. Resolve material ambiguities before dependent work. Continue independent authorized work.
5. Select checks that can demonstrate both the result and the relevant safety properties.

For a new utility, use a separate directory under `apps/`.
Check the npm package name and CLI command against the naming rule in AGENTS.md.
Inspect tsconfig.json and package scripts against the compilation requirements in AGENTS.md.
Check the Vite build, separate TypeScript check, and Vitest test commands.
Check structure, metadata, TypeScript options, and package-local aliases against [the package requirements](../../../docs/PACKAGES.md).
Verify that local startup and npm bin entries use the same compiled entry point in `dist/`.
Do not copy reHistory-specific Git restrictions into an unrelated utility.

## Implement in stages

Separate input validation, plan construction, changes, and result checks when the operation can damage user data.
Use the existing terminal interaction patterns when they meet the task requirements.
Keep reusable business logic independent of terminal prompts where practical.

After each stage, examine its security impact before continuing.
Check the applicable boundaries:

| Boundary     | Questions to resolve                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- |
| Input        | Can malformed values select another target or become executable text?                     |
| Subprocess   | Can inherited environment, config, hooks, helpers, or shell parsing change the operation? |
| File system  | Can links, existing paths, permissions, or concurrent changes cause an unintended write?  |
| Terminal     | Can displayed data inject controls? Does cancellation restore input state?                |
| Network      | Is the destination authorized? What happens after a partial success or a retry?           |
| Recovery     | Can failure leave partial data? Can the user restore the previous state?                  |
| Distribution | Can the archive include secrets, unrelated data, or installation-time execution?          |

For inapplicable boundaries, record why they do not apply instead of adding unnecessary mechanisms.

## Review the completed change

Perform a separate security pass after implementation.
Read the final code and diff, including errors and cleanup paths.
Trace input through validation to each write or subprocess call.
Try relevant malformed inputs and failure cases in isolated fixtures.
Check that the plan, dry-run, and final result agree.

Fix confirmed defects within the task scope.
Add meaningful regression checks for security defects.
Repeat affected checks after each fix.
Report unresolved findings with impact, conditions, evidence, and a recommended action.

For a documentation-only change, examine instruction accuracy and unsafe example commands.
Check references and authorization boundaries. Do not run destructive examples to validate their wording.

## Prepare npm distribution when requested

Read the relevant release guide and package lifecycle scripts first.
Type-check with tsconfig.json, then build with Vite.
Run Vitest unit and integration tests. Check the built application separately.
Verify that a compilation error prevents local startup.
Use the same compiled output for local checks and the package archive.
Make the archive in a separate temporary release directory.
Use a dedicated npm cache and avoid account credentials for local checks.

Examine the actual archive inventory, metadata, entrypoint, permissions, and secret exposure.
Run its help and read-only mode through local offline npm exec from another directory.
Compare the fixture before and after read-only checks.
Check runtime dependency and installation hook changes when present.

Keep the tested archive integrity value with the verification result.
Metadata or included-file changes require a new archive and repeated artifact checks.
Leave publication and real network operations outside this workflow unless the user explicitly authorized them.

## Deliver

Apply the SemVer policy in docs/PACKAGES.md once for each changed application.
Use `npm version` with `--no-git-tag-version --ignore-scripts`, then check package and lockfile versions.
Do not replace user version changes or repeat a completed iteration bump.

Run Prettier on changed maintained files with the existing configuration.
Run format:check and ESLint for the affected application. Fix errors before completion.
Keep generated output and vendored skills outside formatting changes.
Update the utility's operating instructions and security notes as necessary.
Report the result, executed checks, fixed defects, and remaining limits in Russian.
Do not present static review as native platform testing or a formal security certificate.
