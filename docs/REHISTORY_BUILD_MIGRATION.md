# reHistory compiled runtime migration

Review date: 2026-10-29.
Package: `tx-rehistory@2.3.3`.

## Result

The application compiles before local startup.
Local startup and the npm bin use `dist/cli.js`.
The TypeScript configuration uses ES2023, NodeNext, strict checks, and noEmitOnError.
Tests compile into the same output directory and run as JavaScript.
The publication allowlist excludes tests and build tools.

The build compiles into an isolated temporary directory.
Compiler failures preserve the existing output and stop local startup.
Output checks reject symbolic links, hard links, and special files at expected destinations.
These checks run before and after compilation.
The temporary directory is removed after success or failure.

## Security review

The separate review examined configuration, subprocess arguments, output paths, failure paths, dependencies, imports, and the actual archive.
The compiler receives fixed argument arrays without a shell.
The local start script uses a fixed command sequence and stops on build failure.
The runtime comparison found only import extension changes, an updated help path, and explicit constructor parameter types.
No Git operation logic changed.

TypeScript 5.9.3 and Node.js types 24.10.1 are exact development dependencies.
The lockfile pins undici-types 7.16.0 and records integrity values for all three packages.
The packages have no installation hooks.
Installation used disabled lifecycle scripts and an isolated npm configuration.
The npm dependency audit reported zero known vulnerabilities for this tree.
No runtime dependencies were added.

## Completed checks

- All 57 tests passed on Node.js 24.12.0 on macOS.
- Both build regression tests passed on Node.js 26.5.1.
- A type error preserved existing output and prevented its execution through npm start.
- Directory links, file links, and hard links blocked the build without changing external files.
- A clean offline npm ci and build produced identical runtime files.
- The typecheck command and local start help check passed.
- All six archived runtime modules passed Node.js 24.12.0 syntax checks.
- The archive contained exactly 11 expected regular files with matching bytes and permissions.
- Offline npm exec ran help and a JSON audit from another directory.
- Built exports passed verification. A nested unexpected file caused verification to fail.
- The audit source, export source, and rejected verification target remained unchanged.
- Gitleaks found no secrets in the archived files.
- Local documentation links and Git whitespace checks passed.

The checked archive integrity value is:

```text
sha512-6019Yt9vgeYuCWHTNPoQ3wLwFu7D/1pTNnFro/ud9+2foPMFtyjVGZvhXsfbWPbFInTxT/RIn3+6sg4dmfPRzQ==
```

Any change to an included file or package metadata requires a new archive check.

## Remaining limits

The build assumes trusted compiler dependencies and exclusive filesystem access.
A filesystem error during output publication can leave a partial build.
The start command stops on this failure. Rebuild successfully before direct execution.
Direct Node.js execution of `dist/cli.js` uses the last successful build.
Native Linux and Windows checks were not performed.
No real network demo, npm publication, or change to Toolchain Git refs was performed.
Dependency and secret scans do not prove the absence of all defects or sensitive data.

## Later package structure review

The following checks apply after the package structure changes.
They supersede earlier path examples for current development.

Runtime source now belongs to `src/`, tests to `test/`, and build tools to `scripts/`.
The runtime entry point is `dist/src/cli.js`.
Tests execute from `dist/test/`.
The npm archive excludes both tests and build tools.

The package uses private `#rehistory/*` imports with compiled targets in package.json.
The compiler has matching source mappings in tsconfig.json.
The installed package resolves these aliases without source files or a custom loader.
The package has an empty exports map because it supports a CLI rather than a public import API.
Repository metadata records the configured origin and application directory.
Repository availability was not verified. Check it before publication.

The separate security review examined alias resolution, build paths, legacy output removal, metadata, and the actual archive.
The runtime comparison reversed only import changes and the help path.
It found no changes to application behavior against the task baseline.
No dependencies were added or changed during this structure review.

All 58 tests passed on Node.js 24.12.0 on macOS.
Three build safety tests also passed on Node.js 26.5.1.
These tests cover nested directory links and preservation of unknown output files.
A clean offline install and build reproduced the six runtime modules byte-for-byte.
The typecheck and local start checks passed.
The archive contained exactly 11 expected regular files with matching bytes and permissions.
Offline npm exec ran help and a read-only JSON audit outside the source directory.
The archive's export implementation accepted valid output and rejected an unexpected nested file.
The source and checked export remained unchanged.

The new archive integrity value is:

```text
sha512-fnJueFcNUdFThK8nSmUtZ3J+xkYt76/H7djahbsKySS79tR9vzoqOKBCDy1EHvMMoXmeLnW0SEsMkdyRq2ftWg==
```

Gitleaks found no secrets in this archive's extracted files.
The earlier archive integrity value remains a historical record.
No package publication or real network demo was performed.
The existing filesystem trust conditions and platform limits remain applicable.
