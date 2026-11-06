---
name: new-app
description: Add a new CLI application to apps/ in the Toolchain repository. Use when the user asks to create, scaffold, or start a new utility or tx- package.
---

# Add a Toolchain application

Read [AGENTS.md](../../../AGENTS.md) and [the package requirements](../../../docs/PACKAGES.md) before you start.
Use [the toolchain-cli workflow](../toolchain-cli/SKILL.md) for the implementation and security review after the scaffold.
This skill makes the empty application structure. It does not authorize publication, a release, or a push to `master`.

## Collect the inputs

Get these values from the user or from the task before you write files:

| Input          | Rule                                                                                       | Example                     |
| -------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| Directory name | Matches `^[A-Za-z][A-Za-z0-9-]{0,63}$`. Use lower camel case like the existing directory.  | `moveToRepo`                |
| Package name   | `tx-` followed by the directory name in lowercase.                                         | `tx-movetorepo`             |
| CLI command    | The same as the package name.                                                              | `tx-movetorepo`             |
| Alias          | `@<directory-name>/*`. Keep the letter case of the directory.                              | `@moveToRepo/*`             |
| Description    | One English sentence about the result for the user.                                        | `Move files to another...`  |
| Runtime data   | The user data, files, subprocesses, and network targets that the utility reads or changes. | Git repository, local files |

Stop and ask when the directory name or the purpose is not clear.
Do not invent author data, service URLs, or a public API.
Check that no other directory in `apps/` has the same name without letter case.

## Make the files

Use `apps/reHistory` as the reference. Copy only the structure, not the reHistory Git rules.
Start with the smallest working CLI: `--help` and one interactive question are sufficient.

| File                | Content                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `package.json`      | Fields from the next section. `version` is `0.1.0`.                                                                       |
| `tsconfig.json`     | Extend `../../configs/tsconfig.base.json`. Set `rootDir: "."`, `outDir: "dist"`, `paths`, `include`, and `exclude`.       |
| `vite.config.mjs`   | Call `nodeCliConfig` from `../../configs/vite.config.mjs` with `root`, `namespace`, and the runtime module list.          |
| `vitest.config.mjs` | Call `nodeTestConfig` from `../../configs/vitest.config.mjs` and pass `viteConfig.resolve`.                               |
| `scripts/build.mjs` | Adapt the reHistory build script. Set the runtime module list, the temporary directory prefix, and the executable entry.  |
| `src/cli.ts`        | Node.js shebang, Russian help text, a `--help` mode, and a clear stop when an interactive mode has no TTY.                |
| `test/cli.test.ts`  | English test names. Test `--help` and one failure path in a temporary directory.                                          |
| `README.md`         | Purpose, Node.js requirement, start commands, modes, and recovery when the utility changes data.                          |
| `SECURITY.md`       | Required when the utility changes user data or starts subprocesses. Inputs, writes, trust assumptions, and residual risk. |
| `LICENSE`           | Copy the MIT license text from the repository root without changes.                                                       |

Use these `package.json` fields. Replace the placeholders.

```json
{
  "name": "tx-<lowercase-dir>",
  "version": "0.1.0",
  "description": "<description>",
  "private": false,
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=24.12.0" },
  "bin": { "tx-<lowercase-dir>": "dist/src/cli.js" },
  "files": ["dist/src/cli.js", "README.md", "LICENSE"],
  "scripts": {
    "test": "npm run build && vitest run",
    "start": "npm run build && node dist/src/cli.js",
    "typecheck": "tsc --project tsconfig.json --noEmit",
    "build": "node scripts/build.mjs",
    "prepack": "npm run build",
    "lint": "eslint . --max-warnings=0",
    "lint:fix": "eslint . --fix --max-warnings=0",
    "format": "prettier --ignore-path ../../.prettierignore --write .",
    "format:check": "prettier --ignore-path ../../.prettierignore --check .",
    "check": "npm run format:check && npm run lint && npm test"
  },
  "exports": {},
  "repository": { "type": "git", "url": "git+https://github.com/se-panfilov/toolchain.git", "directory": "apps/<dir>" }
}
```

Add each new runtime module to `files`, to `vite.config.mjs`, and to `scripts/build.mjs`.
Add `SECURITY.md` to `files` when it exists.
Do not add `postinstall`, `prepare`, or other installation hooks.
Do not add a runtime dependency without a reason and a security check of its package.
Do not add `release` scripts until the user asks for npm preparation.

## Connect the repository settings

1. Add the directory name to the `app` options in `.github/workflows/test.yml`, `build.yml`, and `release.yml`.
2. Keep `all` first and the directory names in code point order.
3. Add an ESLint block in `configs/eslint.config.mjs` for `apps/<dir>/src/**/*.ts`. Copy the reHistory `no-restricted-imports` block and change the package name and the alias.
4. Add a lint test for the new alias restriction, or extend the existing lint test.
5. Do not change shared configs for one application. Put a necessary exception in the application wrapper and record the reason.

The root `test`, `build`, and `typecheck` scripts use all workspaces. The root Vitest config finds `apps/*` automatically.
Do not add the application to these scripts.

## Install and check

Run these commands from the repository root:

```sh
npm install --ignore-scripts
npm run check:config
npm run check:workflows
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test --workspace tx-<lowercase-dir>
npm run start --workspace tx-<lowercase-dir> -- --help
```

`npm install` adds the workspace link to the root lockfile. Do not add an application lockfile.
Review the lockfile diff. Only the new workspace entries must change.
After that, use `npm ci --ignore-scripts` for later installs.

## Finish

- Do a security review of the scaffold. A help-only CLI still needs a TTY check and safe terminal output.
- Do not run `npm version` for a new application. Its first version is `0.1.0`.
- Do not publish. The first npm publication and the trusted publisher setup need the user. See [the GitHub Actions guide](../../../docs/GITHUB_ACTIONS.md#npm-trusted-publishing).
- Report the new files, the checks, and the open questions in Russian.
