import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('scanner hides recognized secrets in all JSON fields and does not modify checked files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'toolchain-skill-scan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const name = directory.split(/[\\/]/).at(-1)!;
  // Construct a synthetic token without storing a credential-shaped literal in source.
  const token = 'gh' + 'p_' + 'a'.repeat(36);
  const password = 'synthetic' + 'Password42';
  writeFileSync(join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Scan fixture ${token}\npassword: "${password}"\nmetadata:\n  "${token}": fixture\n---\nToken: ${token}\nhttps://example.invalid/${token}\n`);
  mkdirSync(join(directory, 'scripts'));
  writeFileSync(join(directory, 'scripts', 'example.py'), `eval("${token}")\n`);
  function snapshot(): Map<string, Buffer> {
    const result = new Map<string, Buffer>();
    function walk(path: string): void {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) walk(child);
        else result.set(child, readFileSync(child));
      }
    }
    walk(directory);
    return result;
  }
  const before = snapshot();
  const scanner = fileURLToPath(new URL('../../.agents/skills/skill-scanner/scripts/scan_skill.py', import.meta.url));
  const result = spawnSync(process.env.SCANNER_PYTHON || 'python3', [scanner, directory], {
    cwd: directory,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr.toString());
  const output = result.stdout.toString();
  const report = JSON.parse(output);
  assert.equal(report.skill_name, name);
  assert(report.findings.some((finding: { category: string }) => finding.category === 'Secret Exposure'));
  assert(report.findings.some((finding: { category: string }) => finding.category === 'Malicious Code'));
  assert(output.includes('[REDACTED'));
  assert(!output.includes(token));
  assert(!output.includes(password));
  assert.deepEqual(snapshot(), before);
});
