# reHistory Vite and Vitest migration

Review date: 2026-10-29.
Package: `tx-rehistory@2.3.3`.

## Build and aliases

Vite 8.3.5 builds the six runtime modules as ESM for Node.js 24.
TypeScript checks types with `tsc --noEmit` before Vite starts.
The configuration uses ESNext modules and Bundler resolution.
Both build stages finish before output publication.
Local startup and the npm bin still use `dist/src/cli.js`.

Source imports now use `@reHistory/*`.
TypeScript has a matching paths mapping.
Vitest shares Vite's alias configuration.
The built modules use only relative JavaScript imports and Node.js built-ins.
There is no runtime alias loader or package imports mapping.

Vite does not load environment files, copy public files, emit source maps, or minify the runtime.
The executable shebang remains intact.
Output paths retain their link checks and explicit file allowlist.
The build removes only known obsolete output files after success.
Unknown files stop the operation without deletion.

## Tests

All 58 existing tests now run through Vitest 5.0.5.
The migration retains their assertions, Git fixtures, byte comparisons, subprocesses, and isolated demo transport.
Test-scoped cleanup replaces node:test cleanup.
Tests run sequentially in isolated fork workers because some checks change process state.

The new unit suite adds 19 table-driven cases.
It covers time zones, invalid dates, identity controls, environment isolation, and binary signature messages.
A new build regression injects a Vite failure after successful type checking.
It verifies that existing output remains unchanged.

The complete command builds first and runs all five test files.
The unit command runs 30 unit and terminal cases.
The watch command watches those source-only suites.
Built subprocess behavior and installed archive behavior receive separate checks.

## Completed verification

- All 78 tests passed on Node.js 24.12.0 and 26.5.1 on macOS.
- The unit command passed all 30 cases.
- Type checking and local start help completed successfully.
- Source comparison confirmed unchanged runtime logic apart from import names.
- The original assertion bodies remain unchanged after mechanical test API and path replacements.
- Clean offline npm ci with disabled scripts produced identical runtime modules.
- All six archived modules passed Node.js 24.12.0 syntax checks.
- The actual archive contained exactly 11 expected regular files with matching bytes and permissions.
- The installed archive ran help and a read-only JSON audit through offline npm exec from another directory.
- Its export implementation accepted valid output and rejected an unexpected nested file.
- The audit source, export source, and rejected export remained unchanged.
- Generated imports contain no unresolved source aliases.
- Gitleaks found no secrets in the extracted archive.
- The npm dependency audit reported zero known vulnerabilities for the locked tree.

The Node.js 26.5.1 test run took approximately four minutes.
It completed without skipped tests.

The final archive integrity value is:

```text
sha512-rHvmCKHEStMAzyEO18R22BM7D8wTGh1/1p+Xx1x5NiSjrx8tCON424Z1MoCS7+/oj7J1hyD3AjGAwmNrS1XVAA==
```

## Security review and limits

The separate review covered build configuration, output writes, aliases, cleanup, subprocesses, dependencies, and the archive.
The new development tree contains 63 locked package entries, including optional packages for other platforms.
The installed tooling includes native build bindings.
The optional fsevents package declares an installation script. Installation scripts were disabled during the checks.
No runtime dependencies were added. Development dependencies and configuration files are absent from the archive.

The build assumes trusted tool dependencies and exclusive filesystem access.
An I/O error during output publication can still leave a partial build.
Startup stops after that failure. Rebuild successfully before direct execution.
Dependency and secret scans do not prove the absence of all defects or sensitive data.
Windows and Linux were not tested natively.
No real network demo, npm publication, or change to Toolchain Git refs was performed.
Any included-file or metadata change requires another archive check.

## References

- [Vite TypeScript transforms and separate type checking](https://vite.dev/guide/features.html#typescript).
- [Vite build options](https://vite.dev/config/build-options.html).
- [Vitest configuration](https://vitest.dev/config/).
- [Vitest test context and cleanup](https://vitest.dev/guide/test-context).
