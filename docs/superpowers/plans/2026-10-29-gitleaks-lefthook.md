# Gitleaks and Lefthook Implementation Plan

**Goal:** Add root secret checks and a pre-commit hook based on anarchy-engine.

**Architecture:** Lefthook runs read-only staged formatting and secret checks in parallel. Gitleaks extends its official default rules. CI also checks all local refs and working files.

**Constraints:** Keep npm lifecycle scripts disabled. Do not stage or stash files from hooks. Keep scanner findings redacted. Preserve existing hooks during installation.

## Tasks

- [x] Add failing root Vitest fixtures for staged secrets, redaction, alternate indexes, deleted secrets in history, and unchanged repository data.
- [x] Add `.gitleaks.toml`, `lefthook.yml`, and a small Node.js scanner command. Reject unsupported inputs and unsafe Git configuration.
- [x] Test the real Lefthook hook in synthetic repositories. Check formatted input, unformatted input, secrets, and filenames with spaces. Existing formatting regressions cover partial staging.
- [x] Add explicit root installation and verification commands. Keep hook installation separate from npm ci.
- [x] Add a CI job with a checksum-pinned official Gitleaks release and complete Git history.
- [x] Document trusted sources, setup, checks, and remaining limits.
- [x] Run formatting, ESLint, root hook tests, the application suite, and separate security review.

## Review Focus

Alternate indexes must not cause the scanner to inspect another snapshot. Git filters must not execute during scans. Findings must not expose secret bytes. Hook commands must not interpolate filenames. Existing hooks must not be overwritten silently.
