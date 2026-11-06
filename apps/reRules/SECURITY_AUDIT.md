# reRules security audit

## Scope and method

The review covers all runtime source files, the build script, package metadata, runtime dependencies, and existing tests.
Tests use a fake GitHub API or a local response stream. No request changes a real GitHub repository.
The review does not test native Windows behavior or the live GitHub service.

The findings below have regression tests and production fixes. The user authorized the fixes before implementation.

## Findings

### High: branch protection merge can remove a required check's app binding

`src/protection.ts` merges checks by context name. A source check replaces the target check with the same name.
If the target requires app 123, a source check with `app_id: -1` permits any app instead.
A different app ID replaces the trusted producer. `weakenedFields` compares only context names and does not report either change.

The fix keeps an existing target app binding during merge.
An unbound target check can acquire the source binding.
Replace mode reports a removed or changed binding as a protection weakening that needs the existing additional confirmation.

Regression tests are in `test/protection.test.ts`.
The [GitHub API documentation](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection) describes the `app_id` constraint.

### High: an unreadable target secret list permits an unconfirmed overwrite

`src/secrets.ts` treats a failed target read as an empty list.
The plan calls the operation a creation and omits the additional overwrite confirmation.
The secret PUT endpoint can replace an existing value that the program could not read.
Failed environment reads also return partial results as a successful inventory.
The same partial-inventory problem affects the variable plan, although variable creation uses POST instead of the secret PUT operation.

The fix refuses a write plan when the target inventory is incomplete.
Source reads can still return partial results with warnings.
No secret value is requested when the target inventory is unknown.

Regression tests are in `test/categories.test.ts`.

### Medium: API response limits apply after the complete body allocation

`src/github.ts` calls `response.text()` before it checks the actual body size.
A response without an accurate Content-Length can consume memory beyond the stated limit.
The second check counts JavaScript characters instead of UTF-8 bytes.
A test response with 18 MiB of UTF-8 data passes the nominal 16 MiB limit.

The fix counts bytes during stream reads and cancels the reader when the limit is exceeded.
The reader releases its lock after success and failure.
UTF-8 characters split between chunks decode correctly.

Regression tests are in `test/github.test.ts`.

### Medium: unknown organization membership permits automatic collaborator selection

`src/access.ts` treats only a confirmed non-member as an outside collaborator.
A failed membership check leaves the user in the automatically selected set.
The individual grant still needs confirmation, but the question does not identify the unknown membership.

The fix permits automatic selection only for confirmed organization members.
Unknown membership requires manual selection and an explicit label.

A regression test is in `test/categories.test.ts`.

### Medium: unreadable target teams permit replacement of unknown permissions

`src/access.ts` treats a failed target team read as an absent grant.
A source write grant can therefore replace a target administrator grant without a known comparison.
The grant confirmation does not identify this reduction, and it contradicts the documented promise to preserve stronger access.

The fix skips team changes when the target team inventory is unknown.
Independent user grants can continue when their target inventory is available.

A regression test is in `test/categories.test.ts`.

### Medium: custom roles are ranked as weaker than standard roles

`src/access.ts` assigns custom roles rank -1.
An existing custom role can therefore be replaced with a standard source role, although their permissions cannot be compared.
The replacement can remove custom permissions or grant unwanted permissions.

The fix preserves matching roles and skips changes between incomparable roles with a warning.

A regression test is in `test/categories.test.ts`.

## Other reviewed boundaries

- Mutations use a target path guard. Dry-run freezes writes. Redirects do not receive an automatic follow-up request.
- Requests use argument data and JSON bodies, without a shell. The only runtime subprocess reads a token through GitHub CLI.
- Runtime code does not write local files. The build checks output paths for symbolic and hard links before writing.
- Secret encryption uses a sealed box. Existing tests verify decryption with the corresponding private key and exclude plaintext from request bodies.
- The package has an explicit runtime file allowlist. Its two runtime packages are locked to version 0.8.4 and have no installation scripts.
- The upstream [libsodium.js security page](https://github.com/jedisct1/libsodium.js/security) lists no published advisories at review time.
  This check does not establish that the dependencies have no vulnerabilities.

## Verification state

Before the fixes, 16 regression cases failed and reproduced the findings against the original production code.
After the fixes, all 141 reRules tests pass. The build includes a successful TypeScript check.
The root workspace test command passes: 627 tests pass and one platform test is skipped.
Formatting, application ESLint, and the repository configuration check pass after the fixes.
The workflow checks pass with `TMPDIR=/private/tmp` (50 passed, one platform skip).
With the default temporary path, the copied-repository test fails alias checks because of path normalization on macOS.
No check was removed or weakened.

The inspected `tx-rerules@0.1.2` archive contains exactly the 28 allowed files, including the package manifest.
The archive passes the repository inspector for paths, links, metadata, installation hooks, and common secret patterns.
Its executable bin passes help, version, and TTY rejection checks from an offline installation outside the repository.
The installation uses locally packed copies of the locked runtime dependencies. It does not test registry installation.
Archive integrity: `sha512-vbqFnQJjYi2k0QhOwbmixod94D2V47ZKcv5B63Y4uCWljEBESSA4xpM/bmmHCj3oxKcZ/gIdisD99+ONz5dqBw==`.

A separate reviewer inspected the changed source and tests and found no blocking defects.
All six findings above are fixed. Live GitHub effects and native Windows behavior remain outside this verification.
