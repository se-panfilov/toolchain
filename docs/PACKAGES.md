# Application package requirements

These requirements apply to each application under `packages/`.
They are Toolchain conventions based on the official references below.
npm does not require a source directory named `lib`.

## Directory structure

| Directory | Contents |
| --- | --- |
| `src/` | TypeScript runtime source. |
| `test/` | Tests and isolated fixtures. |
| `scripts/` | Build and maintenance tools. |
| `dist/` | Generated JavaScript for local execution, tests, and npm packaging. |

Keep package metadata, tsconfig.json, package-lock.json, README.md, and LICENSE at the application root.
Keep security documentation there when the application changes user data.
Do not maintain a second runtime build in `lib/`.
The output directory can preserve `src/` and `test/` when one compiler project includes both.
Exclude compiled tests and build scripts from publication.

## Package metadata and distribution

- Use the naming rule in [AGENTS.md](../AGENTS.md).
- Specify `description`, `version`, `license`, `type`, `engines`, `bin`, and a narrow `files` allowlist.
- Keep the CLI entry point executable with a Node.js shebang.
- Use the same compiled entry point for local startup and the npm bin.
- Define the supported public API explicitly with `exports`.
- For a CLI without a public import API, use an empty exports object.
- Add declarations and a `types` entry only when the package supports a public TypeScript API.
- Record the actual repository URL and application directory when known. Do not invent author data or service URLs.
- Separate runtime dependencies from build and test dependencies.
- Keep dependencies small and justify each addition. Pin development dependencies and track the lockfile.
- Provide build, typecheck, test, and start scripts. Build before packaging with prepack.
- Stop startup after build failure. Do not depend on installation hooks for runtime readiness.
- Check the actual archive inventory, permissions, metadata, and secrets before release.
- Exercise the archive through offline npm exec outside the source directory.
- Verify an archive integrity value before publication. Any included-file change requires another check.

An exports map defines the supported import API. It is not an access control boundary.
Publication remains subject to the authorization limits in AGENTS.md.

## TypeScript and imports

- Use strict checking and the compilation settings required by AGENTS.md.
- Enable `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `noUnusedLocals`, and `noUnusedParameters`.
- Use `verbatimModuleSyntax`, explicit type imports, and `node:` imports for Node.js built-ins.
- Prefer inferred local types. Give exported boundaries explicit types when inference hides their contract.
- Use `unknown` and validate external data before narrowing it. Do not bypass checks with blanket casts or suppression comments.
- Keep user interaction separate from data processing and side effects.
- Use one package-local alias namespace: `#<directory-name-in-lowercase>/*`.
- Define that namespace in package.json `imports`, with targets inside the package's compiled output.
- For reHistory, use `#rehistory/engine` to resolve `./dist/src/engine.js`.
- Use application aliases for runtime module imports. Use relative paths for nearby test fixtures when clearer.
- If compilation needs source mappings, mirror aliases in tsconfig `paths`.
- Give every source mapping a matching runtime imports entry.
- Do not use `paths` alone as a runtime alias system. It does not rewrite emitted import specifiers.
- Do not use a generic `@` alias or an unresolvable bare alias such as `@reHistory`.
- Do not map another application's source through aliases.
- Use declared package dependencies and supported exports for shared packages.
- Test alias resolution from the installed archive without custom loaders, environment flags, or source files.

Node.js requires private imports keys to start with `#`.
Each namespace belongs to its package. It does not create global access across applications.
Compiler mappings must preserve the same runtime behavior in local builds and installed packages.

## Build and verification

Compile into temporary output before updating the local build.
Reject unsafe output links and unsupported files before writes.
Do not delete unknown files to make a build pass.
Test error paths, stale output, alias resolution, and source-independent archive execution.
Keep changes to runtime behavior separate from structural changes when practical.
Run security review after each stage and separately after implementation.

## References

- [npm package metadata, bin, files, and repository directory](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).
- [Node.js private package imports](https://nodejs.org/api/packages.html#subpath-imports).
- [Node.js package entry points and exports](https://nodejs.org/api/packages.html#package-entry-points).
- [TypeScript paths and emitted imports](https://www.typescriptlang.org/docs/handbook/modules/reference.html#paths).
- [TypeScript compiler options](https://www.typescriptlang.org/tsconfig/).
