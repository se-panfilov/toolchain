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

| Area                 | Check                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base tsconfig        | The required compiler options are present with the documented values.                                                                                                                                                                                                                 |
| Application tsconfig | It extends the base. It sets only `rootDir: "."`, `outDir: "dist"`, and `paths`. The alias is `@<directory>/*` → `./src/*.ts`, with optional `@shared/*`.                                                                                                                             |
| Aliases              | Vite and Vitest resolve `@<directory>` to the application `src/` directory.                                                                                                                                                                                                           |
| Package metadata     | `description`, `license`, `type`, `engines`, a narrow `files` list, `exports`, `repository.directory`, required scripts, one bin entry, and the shebang.                                                                                                                              |
| Dependencies         | Runtime dependencies are in `runtimeDependencyAllowlist`. Applications have no devDependencies. Root devDependencies use exact versions.                                                                                                                                              |
| Lockfile             | The application version agrees with `package-lock.json`.                                                                                                                                                                                                                              |
| Structure            | Uppercase rule file names, rule files only in the root, no tracked `dist/`, one lockfile, no shell scripts outside `shellScriptAllowlist`, no agent host settings files outside `hostConfigAllowlist`, and equal skill adapter descriptions.                                          |
| Workflows            | Read-only top-level `permissions`, no `write-all` at any level, actions pinned to full SHAs with a version comment, `persist-credentials: false` for checkout, no `${{ }}` in `run`, and no forbidden event. See [Workflow check](#workflow-check).                                   |
| Skills               | Each third-party skill file in `.agents/skills` has the SHA-256 value from `docs/skill-provenance.json`. `allowed-tools` contains only tools from `skillToolAllowlist`. SKILL.md has no `hooks` field and no pre-prompt command. Links in `.claude/skills` point to `.agents/skills`. |
| Node.js version      | `.nvmrc` contains an exact version `X.Y.Z`. The release jobs use this Node.js version and its npm.                                                                                                                                                                                    |

### Agent host settings files

Agents load some files automatically. These files can run commands, start MCP servers, grant tool permissions, or replace AGENTS.md.
The structure check rejects these tracked files. Names are not case-sensitive, because the macOS file system is not case-sensitive.

- `.claude/settings.json` and `.claude/settings.local.json`
- `.mcp.json`, `.gemini/settings.json`, and `.codex/config.toml`
- All files in `.cursor/`, and `.vscode/tasks.json`, `.vscode/settings.json`, and `.vscode/mcp.json`
- `AGENTS.override.md` in each directory. Codex reads it instead of AGENTS.md.
- `CLAUDE.local.md` and `GEMINI.local.md` in each directory
- `.cursorrules`, `.windsurfrules`, and `.clinerules` as a file or a directory

`hostConfigAllowlist` in [scripts/ci/config.mjs](../scripts/ci/config.mjs) is empty. Only a human can add an entry.
`.claude/agents/*.md`, `.claude/skills/**`, and `.github/copilot-instructions.md` are permitted.

### Workflow check

The workflow check rejects these events: `pull_request_target`, `workflow_run`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`, `discussion`, and `discussion_comment`.
They run with secrets or write access for code or text that other users write.
The check ignores comment lines. It finds each event, with or without quotes, in four forms:

- A key, for example `workflow_run:`.
- A block list item, for example `- pull_request_target`.
- A flow list or map on the `on` line, for example `"on": [push, issue_comment]`.
- An item on a continuation line of a flow list, for example `  issue_comment]`.

`issues` is not in the list, because `issues:` is also a permission name.

Top-level `permissions` must be read-only: `read-all`, `{}`, or scopes without `write`.
`permissions: write-all` is rejected at each level. A job can give `write` to one scope, for example `security-events: write` for CodeQL.

The workflow check reads the line structure of the workflow files. It is not a complete YAML parser.
YAML anchors and aliases, multi-line keys, and other unusual forms can bypass it. A review must examine each workflow change.

## Git hooks

Install the hooks with `npm run hooks:install`. See [Git hooks and secret checks](GIT_HOOKS.md).

| Hook       | Check                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| pre-commit | No commit on `master` or `main`.                                                                      |
| commit-msg | No link to an AI agent thread, chat, session, or task. No session trailer, such as `Claude-Session:`. |
| pre-push   | No push to `master` or `main`.                                                                        |

[scripts/ci/rules.mjs](../scripts/ci/rules.mjs) contains the shared list of host names and path prefixes. The list covers known services. It cannot find every possible link.

## Pull request rules

The `pr-rules` job in the [PR rules workflow](../.github/workflows/pr-rules.yml) runs [scripts/ci/pr-rules.mjs](../scripts/ci/pr-rules.mjs) on each pull request.
It runs again when the title or description changes. Tests do not run again for that change.
The check is a separate workflow, so a change to the title or description does not make skipped `plan` or `repository` checks. A skipped check counts as successful and can hide a failed result.

1. The branch name is `<type>/<short_description>`. The type is `feature`, `bugfix`, `docs`, `refactor`, `test`, or `chore`. The description has lowercase letters and digits, with `_` between words.
2. The description starts with `## tl;dr`. HTML comments and one italic attribution line can come before it. The `## Changes` and `## Verification` sections are present.
3. The title, the description, and each commit message have no AI agent session links or session trailers.
4. A change to files in `apps/<directory>/` outside `test/` requires one version step: patch, minor, or major. A skipped or reduced version is an error.
5. New or changed packages in `package-lock.json` come from `https://registry.npmjs.org/` with a `sha512` integrity value. A new install script requires a human review. The job lists the changed packages and runs `npm audit --package-lock-only --audit-level=high`.

Dependabot pull requests skip rules 1 and 2 only. The author must be `dependabot[bot]` and the branch must start with `dependabot/`. See [Dependabot](GITHUB_ACTIONS.md#dependabot).

The job does not check the language of the pull request. Russian interface text can appear in it.

## Limits

These checks do not replace a review. They find known patterns and structure problems.
A person or an agent can bypass local hooks. Required status checks and branch rules on GitHub prevent a merge without the CI checks.
