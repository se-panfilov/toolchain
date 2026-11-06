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
