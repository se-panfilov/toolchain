---
name: code-simplifier
description: Simplify Toolchain CLI code for readability while preserving behavior and security. Use for requested refactoring or cleanup of recently changed code.
license: Apache-2.0
metadata:
  upstream-source: getsentry/skills
  upstream-revision: d12f250460ffd961f549dbebf7eeb0cf4afd4c2e
---

<!--
Adapted for Toolchain from Sentry's code-simplifier skill:
https://github.com/getsentry/skills/blob/d12f250460ffd961f549dbebf7eeb0cf4afd4c2e/skills/code-simplifier/SKILL.md
The upstream skill is based on Anthropic's code-simplifier agent:
https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md
Local changes remove React advice and blanket exception-handling preferences.
They add CLI safety invariants, explicit scope, and verification requirements.
-->

# Simplify Toolchain CLI code

Read [AGENTS.md](../../../AGENTS.md) and the affected utility documentation first.
Use the [Toolchain workflow](../toolchain-cli/SKILL.md) for the required security reviews.
This skill grants no additional permission to change data, Git history, or external services.

## Scope

Simplify the files selected by the user or the code changed for the current task.
Do not expand a cleanup into a repository-wide refactor.
Do not modify unrelated user changes or generated build output.

## Preserve behavior

Keep public APIs, return values, exit codes, file contents, and ordering intact.
Keep Russian prompts, help, errors, and confirmation defaults intact unless the task requests a text change.
Keep TypeScript directly executable on the package's supported Node.js versions.
Preserve explicit runtime import extensions and the separate JavaScript distribution build.

Preserve these safety properties when present:

- Input validation and rejection of ambiguous states.
- Subprocess argument arrays, environment isolation, and disabled hooks.
- Path checks, file permissions, link checks, and overwrite protection.
- Read-only plans, dry-run behavior, state checks, and ref transactions.
- Recovery files, backups, locks, and partial-failure diagnostics.
- Terminal cancellation, raw mode restoration, and event handler cleanup.
- Explicit authorization for writes, network actions, and signature removal.

Do not remove try/catch/finally blocks merely to reduce nesting.
Keep error propagation, cancellation, cleanup, and recovery semantics intact.
Keep comments that explain a security invariant or a non-obvious platform constraint.
Write new code comments in English.

## Improve readability

Prefer explicit control flow to nested ternaries and dense expressions.
Use names that express the role of data and operations.
Remove redundant abstractions only when their removal improves understanding.
Keep validation, planning, writes, and verification distinct when this separation protects user data.
Use early returns only when they preserve cleanup and error behavior.
Do not introduce a dependency, framework, or new build step for cosmetic simplification.
Do not apply React conventions to a terminal utility.
Choose clarity over fewer lines or fewer tokens.

## Verify the change

1. Identify the behavior and safety properties affected by the refactor.
2. Make the smallest useful change.
3. Read the complete diff, including failure and cleanup paths.
4. Run the relevant existing checks in isolated fixtures.
5. Add a regression check if the change exposes a security defect or missing behavioral coverage.
6. Perform the separate security review required by AGENTS.md.
7. Report the result, executed checks, and remaining limits in Russian.

Do not execute a rewrite or network demo against real user data to validate a cleanup.
