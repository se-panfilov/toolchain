# Toolchain

Toolchain is an npm workspaces monorepository for local CLI utilities.
Applications live in `apps/` and use `tx-<lowercase-directory-name>` for package and command names.
The root package is private.

| Path                 | Purpose                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `apps/`              | Independently publishable CLI packages.                                          |
| `configs/`           | Shared ESLint, Prettier, TypeScript, Vite, and Vitest settings.                  |
| `package.json`       | Workspace definitions, shared development dependencies, and repository commands. |
| `package-lock.json`  | One locked dependency tree for all workspaces.                                   |
| `docs/`              | Project requirements, writing rules, and verification records.                   |
| `.github/workflows/` | Test, build, release, secret scan, and CodeQL workflows for GitHub Actions.      |
| `scripts/ci/`        | Application selection, archive checks, and release steps for the workflows.      |

## GitHub Actions

The three application workflows are Tests, Build, and Release.
Each application workflow can use all applications or one application, and has a dry-run mode.
The separate Secrets workflow checks repository history and working files. See [Git hooks and secret checks](docs/GIT_HOOKS.md).
The separate CodeQL workflow does static security analysis of the source and the workflows.
Release publishes new application versions to npm through trusted publishing.
See the [GitHub Actions guide](docs/GITHUB_ACTIONS.md).

**CAUTION: When you add, remove, or rename an application, update the `app` list in each application workflow.**
Then run `npm run check:workflows`.

## Development

Do all work on a task branch. Do not work directly on `master` or `main`.
You may commit task changes and push the task branch to the repository remote.
When GitHub access is available, open a pull request for the task branch.
AI agents never merge pull requests. A human makes the final decision on critical questions, including security. See [human decisions](AGENTS.md#human-decisions).
Follow the [Git authorization rules](AGENTS.md#authorization-and-git) and [commit and pull request writing rules](docs/WRITING.md#commits-and-pull-requests).

Use Node.js 24.12 or later.
Run installation and repository commands from this directory:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run typecheck
npm run lint
npm run format
npm run check
```

Install local commit checks with `npm run hooks:install` after installing Gitleaks.
See [Git hooks and secret checks](docs/GIT_HOOKS.md) for prerequisites, configuration sources, CI checks, and operating limits.

The check command runs formatting checks, lint, the GitHub Actions list check, and all workspace tests.
Each application test command builds and checks TypeScript before testing.
Build output in each application's `dist/` is the runtime for local use and npx.

Use `npm run clean:reinstall` to reinstall the locked dependencies with installation scripts disabled.
Use `npm run prettier:changed -- --check` to check tracked changes without writes.
Use `npm run prettier:changed` to format those files.
Use `npm run pretty-quick` to format staged files without updating the index.
The staged command rejects files that also have unstaged changes.
See the [formatting command limits](docs/ESLINT.md#repository-formatting-commands) before use.

Select an application with its workspace name:

```sh
npm run build --workspace tx-rehistory
npm test --workspace tx-rehistory
npm run start --workspace tx-rehistory -- --help
npm pack --workspace tx-rehistory
npm run start --workspace tx-recast -- --help
npm run start --workspace tx-movetorepo -- --help
```

Run npm ci once at the root, not inside applications.
Common development tools and their settings belong at the root and in `configs/`.
Application config wrappers retain their own paths, aliases, and entry points.
Applications declare their own runtime dependencies.
Do not add a lockfile for an individual application.

The documentation and code comments use English.
The CLI interface uses Russian.

- [moveToRepo](apps/moveToRepo/README.md) copies local files into a GitHub repository through a new branch and a pull request.
- [reCast](apps/reCast/README.md) converts a video file into an MP4 file for Chromecast and other streaming devices on macOS.
- [reHistory](apps/reHistory/README.md) changes Git commit dates, authors, or messages, one flow per run, and makes a verifiable export.
- [Agent instructions](AGENTS.md) define development and authorization rules.
- [Workspace guide](docs/WORKSPACES.md) describes shared configuration and adding an application.
- [Package requirements](docs/PACKAGES.md) define workspace layout, versions, TypeScript, and distribution.
- [GitHub Actions](docs/GITHUB_ACTIONS.md) describes the test, build, and release workflows.
- [Agent setup](docs/AI_AGENTS.md) describes vendor integration.
- [Writing rules](docs/WRITING.md) apply ASD-STE100 writing principles.
- [ESLint rules](docs/ESLINT.md) describe the CLI adaptations and migration checks.
