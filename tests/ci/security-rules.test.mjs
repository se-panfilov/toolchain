// Regression tests for bypasses of the workflow and structure checks in scripts/ci/config.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { structureProblems, workflowRuleProblems } from '../../scripts/ci/config.mjs';

const jobs = `jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
const readOnly = 'permissions:\n  contents: read\n';
const workflow = (on, permissions = readOnly, body = jobs) => `name: Demo\n${on}${permissions}${body}`;
const problems = (text) => workflowRuleProblems('demo.yml', text).join('\n');
const eventProblem = (event) => new RegExp(`${event} `);

test('a forbidden event in a block list item is rejected', () => {
  assert.match(problems(workflow('on:\n  - push\n  - pull_request_target\n')), eventProblem('pull_request_target'));
  assert.match(problems(workflow('on:\n  - push\n  - "issue_comment"   # comment\n')), eventProblem('issue_comment'));
});

test('a forbidden event with a quoted on key is rejected', () => {
  assert.match(problems(workflow('"on": [push, pull_request_target]\n')), eventProblem('pull_request_target'));
  assert.match(problems(workflow("'on': { push: {}, workflow_run: {} }\n")), eventProblem('workflow_run'));
});

test('a forbidden event as a quoted key is rejected', () => {
  assert.match(problems(workflow("on:\n  'workflow_run':\n    workflows: [Tests]\n")), eventProblem('workflow_run'));
  assert.match(problems(workflow('on:\n  "pull_request_review":\n')), eventProblem('pull_request_review'));
});

test('a forbidden event in a flow list on a continuation line is rejected', () => {
  assert.match(problems(workflow('on: [push,\n  issue_comment]\n')), eventProblem('issue_comment'));
  assert.match(problems(workflow('on: [push,\n  "pull_request_review_comment", pull_request]\n')), eventProblem('pull_request_review_comment'));
});

test('discussion events are rejected', () => {
  assert.match(problems(workflow('on:\n  discussion:\n')), eventProblem('discussion'));
  assert.match(problems(workflow('on: [push, discussion_comment]\n')), eventProblem('discussion_comment'));
});

test('comment lines, similar names, and the issues and discussions permissions are not events', () => {
  const text = workflow('on:\n  # pull_request_target: is not used\n  pull_request:\n  push:\n', 'permissions:\n  contents: read\n  issues: read\n  discussions: read\n');
  assert.equal(problems(text), '');
});

test('top-level write permissions are rejected', () => {
  for (const permissions of [
    'permissions: write-all\n',
    'permissions: { contents: write }\n',
    "'permissions': {contents: read, pull-requests: write}\n",
    'permissions:\n  contents: write\n',
    'permissions:\n  contents: read\n  # comment\n  id-token: write\n'
  ]) {
    assert.match(problems(workflow('on: push\n', permissions)), /permissions/, permissions);
  }
});

test('a missing top-level permissions key is rejected', () => {
  assert.match(problems(workflow('on: push\n', '', 'jobs:\n  test:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n')), /permissions/);
});

test('write-all is rejected at the job level', () => {
  const body = 'jobs:\n  test:\n    permissions: write-all\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  assert.match(problems(workflow('on: push\n', readOnly, body)), /write-all/);
});

test('read-only top-level permissions and job-level write for one scope are allowed', () => {
  const job = 'jobs:\n  analyze:\n    permissions:\n      contents: read\n      security-events: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  for (const permissions of ['permissions: read-all\n', 'permissions: {}\n', 'permissions: { contents: read }\n', readOnly, 'permissions: # comment\n  contents: read\n']) {
    assert.equal(problems(workflow('on: push\n', permissions, job)), '', permissions);
  }
});

test('agent host settings files are rejected', () => {
  const files = [
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.mcp.json',
    '.gemini/settings.json',
    '.codex/config.toml',
    '.cursor/rules/demo.mdc',
    '.cursor/mcp.json',
    '.vscode/tasks.json',
    '.vscode/settings.json',
    '.vscode/mcp.json',
    '.vscode/extensions.json',
    '.vscode/launch.json',
    'AGENTS.override.md',
    'apps/demoApp/AGENTS.override.md',
    'CLAUDE.local.md',
    'GEMINI.local.md',
    '.cursorrules',
    '.windsurfrules',
    '.clinerules',
    '.clinerules/rules.md',
    '.Claude/Settings.json'
  ];
  for (const file of files) assert.match(structureProblems([file]).join('\n'), /hostConfigAllowlist/, file);
});

test('agent definitions, skills, and Copilot instructions are allowed', () => {
  const files = ['.claude/agents/security-reviewer.md', '.claude/skills/toolchain-cli/SKILL.md', '.github/copilot-instructions.md', 'AGENTS.md'];
  assert.deepEqual(structureProblems(files), []);
});
