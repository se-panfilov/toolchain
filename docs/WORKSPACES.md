# npm workspaces

## Layout

The private root package declares `apps/*` as workspaces.
Each application keeps its own name, version, runtime dependencies, bin, and publication allowlist.
Shared development dependencies belong to the root package.json.
One root package-lock.json records the complete dependency tree.

| Shared configuration          | Application configuration                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `configs/eslint.config.mjs`   | Root discovery supplies the shared rules. An application needs no duplicate file.    |
| `configs/prettier.config.mjs` | Root discovery supplies formatting. Application commands use the root ignore file.   |
| `configs/tsconfig.base.json`  | Application tsconfig.json extends the base and sets local paths and inputs.          |
| `configs/vite.config.mjs`     | Application vite.config.mjs supplies its root, alias namespace, and runtime entries. |
| `configs/vitest.config.mjs`   | Application vitest.config.mjs supplies its root and the Vite alias mapping.          |

Path settings remain local because relative paths resolve from their configuration file.
Build and test presets disable environment-file loading.
The test preset keeps process isolation and limits parallel workers to three or the available CPU count.
The root Vitest configuration discovers application projects under apps.
Run builds before a direct Vitest integration run.
The root npm test command already builds each application before its tests.

## Commands

Run these commands from the repository root:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run typecheck
npm run format
npm run lint
npm run check
```

Select one application when necessary:

```sh
npm run build --workspace tx-rehistory
npm test --workspace tx-rehistory
npm run test:watch --workspace tx-rehistory
npm run start --workspace tx-rehistory -- --repo /path/to/project
npm pack --workspace tx-rehistory --pack-destination /path/to/release-directory
```

npm runs workspace scripts in the application directory.
Specify the target repository when you run reHistory through npm.
The root package has no release command and cannot be published.
A selected application remains independently publishable after its checks and required authorization.
Shared source configurations and development tools are unnecessary for its installed runtime.

## Add an application

1. Create `apps/<directory-name>` and its package.json.
2. Set its package and command names to `tx-<directory-name-in-lowercase>`.
3. Follow the [package requirements](PACKAGES.md) for source, tests, build, and publication files.
4. Extend the shared TypeScript base and use the shared Vite and Vitest presets.
5. Set local paths, the application alias, and runtime entry modules.
6. Provide build, typecheck, test, and start scripts for the root aggregate commands.
7. Declare application runtime dependencies in that application.
8. Add shared development tools at the root only when needed.
9. Run `npm install --ignore-scripts` from the root to update its lockfile and workspace links.
10. Run the relevant checks and inspect the application's actual archive.

Do not create an application lockfile.
Do not add another application's source as a TypeScript alias.
Use declared package dependencies and supported exports when applications share a published package.
Do not bypass application build-path checks through the shared Vite preset.
A successful TypeScript check must precede publication of compiled output.

## Migration verification

The migration keeps all 157 existing dependency entries unchanged.
The root lockfile adds the application workspace and its local package link.
No runtime dependency or installation hook was added.
reHistory's package version is 2.5.3.
Its runtime source and publication allowlist are unchanged.

The root formatting, lint, and workspace test commands passed on macOS with Node.js 26.5.1.
All 124 application tests passed.
A clean offline root installation also passed all 124 tests with Node.js 24.12.0 and Git 2.56.0.
Its seven compiled runtime modules matched the primary build byte for byte.
The root Vitest project configuration also passed the 31 unit and terminal tests.
The application archive contains 12 files and no shared source configurations or development dependencies.
Offline npm exec from a separate directory passed help and read-only audit checks.
The compiled archive passed export and negative verification checks without changing the source fixture.
Native Linux and Windows results require the configured CI jobs.

## References

- [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/).
- [Reference repository layout](https://github.com/se-panfilov/anarchy-engine).
