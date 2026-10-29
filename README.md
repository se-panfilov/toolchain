# Toolchain

Toolchain is an npm workspaces monorepository for local CLI utilities.
Applications live in `apps/` and use `tx-<lowercase-directory-name>` for package and command names.
The root package is private.

| Path                | Purpose                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `apps/`             | Independently publishable CLI packages.                                          |
| `configs/`          | Shared ESLint, Prettier, TypeScript, Vite, and Vitest settings.                  |
| `package.json`      | Workspace definitions, shared development dependencies, and repository commands. |
| `package-lock.json` | One locked dependency tree for all workspaces.                                   |
| `docs/`             | Project requirements, writing rules, and verification records.                   |

## Development

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

The check command runs formatting checks, lint, and all workspace tests.
Each application test command builds and checks TypeScript before testing.
Build output in each application's `dist/` is the runtime for local use and npx.

Select an application with its workspace name:

```sh
npm run build --workspace tx-rehistory
npm test --workspace tx-rehistory
npm run start --workspace tx-rehistory -- --help
npm pack --workspace tx-rehistory
```

Run npm ci once at the root, not inside applications.
Common development tools and their settings belong at the root and in `configs/`.
Application config wrappers retain their own paths, aliases, and entry points.
Applications declare their own runtime dependencies.
Do not add a lockfile for an individual application.

The documentation and code comments use English.
The CLI interface uses Russian.

- [reHistory](apps/reHistory/README.md) changes Git dates and makes a verifiable export.
- [Agent instructions](AGENTS.md) define development and authorization rules.
- [Workspace guide](docs/WORKSPACES.md) describes shared configuration and adding an application.
- [Package requirements](docs/PACKAGES.md) define workspace layout, versions, TypeScript, and distribution.
- [Agent setup](docs/AI_AGENTS.md) describes vendor integration.
- [Writing rules](docs/WRITING.md) apply ASD-STE100 writing principles.
