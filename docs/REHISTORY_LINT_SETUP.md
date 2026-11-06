# reHistory formatting and lint setup

Review date: 2026-10-29.
Package: `tx-rehistory@2.3.3`.

## Configuration

Prettier uses the existing .prettierrc and .prettierignore without content changes.
ESLint uses a flat configuration with the recommended JavaScript and TypeScript rules.
Node.js globals apply to application code, configuration, scripts, and tests.
Intentionally unused TypeScript arguments and caught errors can use an underscore prefix.
eslint-config-prettier disables conflicting style rules. Prettier runs separately from ESLint.
Generated output, dependencies, coverage, and reports are excluded.

The package provides format, format:check, lint, lint:fix, and check commands.
The check command runs formatting checks, lint, type checks, and the complete test suite.
Lint warnings fail the command.
Agent instructions require formatting and lint before completion.

## Changes and security review

Prettier 3.9.10, ESLint 10.13.0, and typescript-eslint 8.72.0 are pinned development dependencies.
The recommended configuration packages and Node.js globals are also pinned in the lockfile.
Installation preserved min-release-age=7 and disabled installation scripts.
The newer typescript-eslint patch was rejected by the age policy. The selected version satisfies that policy.
The updated development tree contains 157 locked package entries, including platform-specific optional packages.
No runtime dependencies were added.

Three contextual errors now preserve their original cause.
Their messages, recovery instructions, and cleanup paths remain unchanged.
Two terminal assertions use explicit spacing counts and an exact ANSI string comparison.
A baseline comparison of 15 code and configuration files confirmed only formatting and these five declared fixes.
No recommended lint rule was disabled to hide an existing error.

The separate review examined configurations, scripts, failure paths, dependency boundaries, formatting scope, and the actual archive.
The write-format command keeps generated output and ignored files untouched.
The read-only formatting command detects incorrect formatting without writing the checked file.

## Completed checks

- The complete check command passed on Node.js 24.12.0 on macOS.
- All 78 Vitest tests passed.
- ESLint and Prettier checks passed without warnings.
- Negative probes confirmed TypeScript lint errors, JavaScript lint errors, and read-only formatting failures.
- Changed project instructions and this report passed Prettier checks.
- A clean offline installation with disabled scripts passed formatting, lint, and build checks.
- The clean build reproduced all six runtime modules byte-for-byte.
- The actual archive contained exactly 11 expected regular files with matching bytes and permissions.
- All six archived modules passed Node.js 24.12.0 syntax checks.
- Offline npm exec ran help and a read-only JSON audit from another directory.
- The archived export implementation accepted valid output and rejected an unexpected nested file.
- Source and verification fixture bytes remained unchanged during read-only checks.
- The npm dependency audit reported zero known vulnerabilities.
- Gitleaks found no secrets in the extracted archive.

The checked archive integrity value is:

```text
sha512-V+yhaR7QzfDc060BAL2cinGA0j4l7fAbJp1gAnLq07PGACLpRi7IfkUqkxKJoJhr0BEGHflEEmv1w5nPg2F1Wg==
```

Any change to package metadata or included files requires a new archive check.
Lint, formatting, dependency checks, and secret scans do not establish complete security or correctness.
The existing filesystem trust conditions and platform limits remain applicable.
No npm publication, real network demo, or Toolchain Git ref change was performed.

## References

- [typescript-eslint recommended configuration](https://typescript-eslint.io/getting-started/).
- [ESLint flat configuration](https://eslint.org/docs/latest/use/configure/configuration-files).
- [Prettier integration with linters](https://prettier.io/docs/integrating-with-linters).
