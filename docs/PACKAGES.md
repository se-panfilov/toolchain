# Application package requirements

These requirements apply to each application under `apps/`.
They are Toolchain conventions based on the official references below.
npm does not require a source directory named `lib`.

`npm run check:config` checks most requirements in this file. See [Enforced rules](ENFORCED_RULES.md).

## Directory structure

| Directory  | Contents                                           |
| ---------- | -------------------------------------------------- |
| `src/`     | TypeScript runtime source.                         |
| `test/`    | Vitest tests and isolated fixtures.                |
| `scripts/` | Build and maintenance tools.                       |
| `dist/`    | Vite output for local execution and npm packaging. |

Keep package metadata, tsconfig.json, README.md, and LICENSE at the application root.
Keep one package-lock.json at the repository root.
Install dependencies from the repository root.
Do not add application lockfiles or application-local copies of shared development tools.
Keep security documentation there when the application changes user data.
Do not maintain a second runtime build in `lib/`.
The output directory can preserve `src/` when the Vite configuration preserves runtime modules.
Exclude tests and build scripts from publication.

## Package metadata and distribution

- Use the naming rule in [AGENTS.md](../AGENTS.md).
- Specify `description`, `version`, `license`, `type`, `engines`, `bin`, and a narrow `files` allowlist.
- Keep the CLI entry point executable with a Node.js shebang.
- Use the same compiled entry point for local startup and the npm bin.
- Define the supported public API explicitly with `exports`.
- For a CLI without a public import API, use an empty exports object.
- Add declarations and a `types` entry only when the package supports a public TypeScript API.
- Record the actual repository URL and application directory when known. Do not invent author data or service URLs.
- Keep runtime dependencies in the application that uses them.
- Keep shared build and test dependencies in the private root package.
- Keep dependencies small and justify each addition. Pin development dependencies and track the lockfile.
- Add each approved runtime dependency to `runtimeDependencyAllowlist` in [scripts/ci/config.mjs](../scripts/ci/config.mjs). The check rejects other runtime dependencies.
- Provide build, typecheck, test, and start scripts. Build before packaging with prepack.
- Stop startup after build failure. Do not depend on installation hooks for runtime readiness.
- Check the actual archive inventory, permissions, metadata, and secrets before release.
- Exercise the archive through offline npm exec outside the source directory.
- Verify an archive integrity value before publication. Any included-file change requires another check.

An exports map defines the supported import API. It is not an access control boundary.
Publication remains subject to the authorization limits in AGENTS.md.

## Version policy

Update each changed application's version once per completed iteration.
Choose the increment from the observable changes to that application.
Use the largest required increment when an iteration combines different change types.

| Increment | Change                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `patch`   | Compatible bug or security fixes, performance improvements, internal refactoring, packaging corrections, or application documentation changes. |
| `minor`   | New backward-compatible application functionality or a public deprecation.                                                                     |
| `major`   | Incompatible changes to the supported CLI, JSON output contract, defaults, runtime requirements, or public API.                                |

Repository-only instructions do not require changing an unaffected application version.
The `pr-rules` CI job requires one version step when a pull request changes files in `apps/<directory>/` outside `test/`.
A directory move does not require a major increment when the installed CLI contract remains compatible.
Do not repeat a bump already completed by the user for the same iteration.
Use prerelease identifiers only when the release channel requires them.

Before changing a version, inspect root scripts, application scripts, and current metadata.
Run this command from the repository root:

```sh
npm version patch --workspace tx-rehistory --no-git-tag-version --ignore-scripts
```

Replace `tx-rehistory` with the changed workspace name.
Replace `patch` with `minor` or `major` when required.
Never edit version strings directly in package.json or lockfiles.
The command must update the application manifest and its entry in the root npm lockfile together.
The private root package has an independent version and is not published.
The flags prevent Git commits, Git tags, and version lifecycle scripts.
Do not use `--force` to bypass version checks.
Verify the resulting version and lockfile consistency.
A version change does not authorize publication.

## TypeScript and imports

- Use strict checking and the compilation settings required by AGENTS.md.
- Enable `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noUnusedLocals`, and `noUnusedParameters`.
- Enable `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Check each index result and each regular expression group before use.
- Do not use non-null assertions to satisfy these checks. Use an explicit check that stops with an error, or a value that fails the next validation.
- Use `verbatimModuleSyntax`, explicit type imports, and `node:` imports for Node.js built-ins.
- Prefer inferred local types. Give exported boundaries explicit types when inference hides their contract.
- Use `unknown` and validate external data before narrowing it. Do not bypass checks with blanket casts or suppression comments.
- Keep user interaction separate from data processing and side effects.
- Use one application alias namespace: `@<directory-name>/*`. Preserve the directory's letter case.
- Define it in Vite resolve aliases, with the application's absolute source path.
- For reHistory, use `@reHistory/engine` to resolve `src/engine.ts` during the build.
- Use application aliases for runtime module imports. Use relative paths for nearby test fixtures when clearer.
- Mirror the alias in tsconfig `paths` and Vitest resolution.
- Keep these mappings consistent. Share the mapping between Vite and Vitest where practical.
- Do not use `paths` alone as a runtime alias system. It does not rewrite emitted import specifiers.
- Do not use a generic `@` alias. Use the application's namespace, such as `@reHistory`.
- Resolve aliases through Vite before distribution. Reject unresolved source aliases in generated imports.
- Do not map another application's source through aliases.
- Use declared package dependencies and supported exports for shared packages.
- Test alias resolution from the installed archive without custom loaders, environment flags, or source files.

Application aliases are build-time mappings, not native Node.js package imports.
Do not depend on package.json imports or a runtime loader to resolve these aliases.
Each namespace belongs to its application. It does not create global access across applications.
The generated modules must work in local builds and installed packages.

## Build and verification

Maintain shared Prettier, ESLint, TypeScript, Vite, and Vitest settings in `configs/`.
Use root discovery files to expose the shared ESLint, Prettier, and Vitest configuration.
Keep application wrappers small and limited to local roots, aliases, entries, and documented exceptions.
Extend the shared TypeScript base from each application tsconfig.json.
Set rootDir, outDir, include, exclude, and alias paths locally because they are relative to their config file.
Use recommended JavaScript rules and type-checked TypeScript ESLint rules.
Application source uses the strict type-checked set. Application tests use the recommended type-checked set.
Apply the adapted [ESLint rules](ESLINT.md) for Node.js applications.
Use eslint-config-prettier to disable conflicting formatting rules. Keep Prettier separate from ESLint.
Provide format, format:check, lint, and check commands.
Before completing work, format changed maintained files and run the format check and application lint.
Exclude generated output, dependencies, coverage, and reports from these tools.
Preserve existing formatting choices and ignore files.
Use Vite for every TypeScript application build.
Run `tsc --noEmit` before the Vite build. Vite does not check types.
Use `ESNext` modules and `Bundler` resolution in TypeScript for Vite applications.
Set the Vite build target for the supported runtime explicitly.
For Node.js CLIs, emit ESM, preserve built-in imports, and keep the executable shebang.
Disable environment-file loading for CLI builds unless an explicit requirement needs it.
Build into temporary output before updating the local build.
Reject unsafe output links and unsupported files before writes.
Do not delete unknown files to make a build pass.
Test error paths, stale output, alias resolution, and source-independent archive execution.
Use Vitest for unit and integration tests in every TypeScript application.
Migrate existing tests when their assertions, isolation, cleanup, and safety properties can be preserved.
Use test-scoped cleanup and restore changed environment or global state.
Run tests that modify process state sequentially within a file.
Parallel files must use isolated processes and independent temporary fixtures.
Bound worker count by available CPUs and expected resource use.
Measure full-suite runtime before and after performance changes.
Keep security assertions and failure cases in the complete suite.
Avoid duplicate type checks when the tested build already requires `tsc --noEmit`.
Include failure cases for changes to user data. Do not replace these checks with mocked success paths.
Vitest can transform source modules for tests. Also check the actual build and installed archive.
Keep changes to runtime behavior separate from structural changes when practical.
Run security review after each stage and separately after implementation.

## References

- [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/).
- [Semantic Versioning 2.0.0](https://semver.org/).
- [npm version and Git tag controls](https://docs.npmjs.com/cli/v11/commands/npm-version/).
- [npm package metadata, bin, files, and repository directory](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).
- [Vite TypeScript transforms and type checking](https://vite.dev/guide/features.html#typescript).
- [Vite build configuration](https://vite.dev/config/build-options.html).
- [Vitest configuration and isolation](https://vitest.dev/config/).
- [Node.js package entry points and exports](https://nodejs.org/api/packages.html#package-entry-points).
- [TypeScript paths and emitted imports](https://www.typescriptlang.org/docs/handbook/modules/reference.html#paths).
- [TypeScript compiler options](https://www.typescriptlang.org/tsconfig/).
