# Enforced rules

Tools check part of the rules in [AGENTS.md](../AGENTS.md) and the documents in `docs/`.
The checks are the same for each person and each AI agent, because they use only repository files, Git, and GitHub Actions.
They do not use vendor-specific agent hooks.

Cloud agents work in a new clone. Local Git hooks are not installed there, because `npm ci --ignore-scripts` does not install them.
For this reason, CI repeats each hook check. Branch protection on GitHub is the last control.

## ESLint

The shared [configuration](../configs/eslint.config.mjs) has these project rules. See [ESLint rules](ESLINT.md) for the full rule table.

| Rule                                                                  | Source                   |
| --------------------------------------------------------------------- | ------------------------ |
| No `exec` or `execSync` import, and no `shell` option except `false`. | AGENTS.md, Security      |
| Node.js built-in modules use the `node:` prefix.                      | PACKAGES.md              |
| Test names have no Cyrillic text.                                     | WRITING.md               |
| Code comments have no Cyrillic text.                                  | AGENTS.md, Documentation |
| An application imports only its own alias and `@shared/*`.            | PACKAGES.md              |

## Configuration check

`npm run check:config` runs [scripts/ci/config.mjs](../scripts/ci/config.mjs). The `repository` job in Tests runs it too.

| Area                 | Check                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base tsconfig        | The required compiler options are present with the documented values.                                                                                                            |
| Application tsconfig | It extends the base. It sets only `rootDir: "."`, `outDir: "dist"`, and `paths`. The alias is `@<directory>/*` → `./src/*.ts`, with optional `@shared/*`.                        |
| Aliases              | Vite and Vitest resolve `@<directory>` to the application `src/` directory.                                                                                                      |
| Package metadata     | `description`, `license`, `type`, `engines`, a narrow `files` list, `exports`, `repository.directory`, required scripts, one bin entry, and the shebang.                         |
| Dependencies         | Runtime dependencies are in `runtimeDependencyAllowlist`. Applications have no devDependencies. Root devDependencies use exact versions.                                         |
| Lockfile             | The application version agrees with `package-lock.json`.                                                                                                                         |
| Structure            | Uppercase rule file names, rule files only in the root, no tracked `dist/`, one lockfile, no shell scripts outside `shellScriptAllowlist`, and equal skill adapter descriptions. |
| Workflows            | Top-level `permissions`, actions pinned to full SHAs with a version comment, `persist-credentials: false` for checkout, no `${{ }}` in `run`, and no `pull_request_target`.      |

The workflow check reads the line structure of the workflow files. It is not a complete YAML parser.

## Git hooks

Install the hooks with `npm run hooks:install`. See [Git hooks and secret checks](GIT_HOOKS.md).

| Hook       | Check                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| pre-commit | No commit on `master` or `main`.                                                                      |
| commit-msg | No link to an AI agent thread, chat, session, or task. No session trailer, such as `Claude-Session:`. |
| pre-push   | No push to `master` or `main`.                                                                        |

[scripts/ci/rules.mjs](../scripts/ci/rules.mjs) contains the shared list of host names and path prefixes. The list covers known services. It cannot find every possible link.

## Pull request rules

The `pr-rules` job in [Tests](../.github/workflows/test.yml) runs [scripts/ci/pr-rules.mjs](../scripts/ci/pr-rules.mjs) on each pull request.
It runs again when the title or description changes.

1. The branch name is `<type>/<short_description>`. The type is `feature`, `bugfix`, `docs`, `refactor`, `test`, or `chore`. The description has lowercase letters and digits, with `_` between words.
2. The description starts with `## tl;dr`. HTML comments and one italic attribution line can come before it. The `## Changes` and `## Verification` sections are present.
3. The title, the description, and each commit message have no AI agent session links or session trailers.
4. A change to files in `apps/<directory>/` outside `test/` requires one version step: patch, minor, or major. A skipped or reduced version is an error.
5. New or changed packages in `package-lock.json` come from `https://registry.npmjs.org/` with a `sha512` integrity value. A new install script requires a human review. The job lists the changed packages and runs `npm audit --package-lock-only --audit-level=high`.

The job does not check the language of the pull request. Russian interface text can appear in it.

## Limits

These checks do not replace a review. They find known patterns and structure problems.
A person or an agent can bypass local hooks. Required status checks and branch rules on GitHub prevent a merge without the CI checks.
