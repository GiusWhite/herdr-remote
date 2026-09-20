import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listCommands } from '../commands.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-cmd-'));
  const write = (rel, body) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  return { root, write };
}

test('skills are read from their frontmatter', () => {
  const { root, write } = fixture();
  write('config/skills/tdd/SKILL.md', '---\nname: tdd\ndescription: Test-driven development.\n---\nbody');
  write('config/skills/wizard/SKILL.md', '---\ndescription: Interactive wizard.\nargument-hint: "what to provision"\n---\n');

  const got = listCommands({ roots: [path.join(root, 'config')] });
  assert.deepEqual(got.map((c) => c.name).sort(), ['tdd', 'wizard']);
  assert.equal(got.find((c) => c.name === 'tdd').description, 'Test-driven development.');
  // No `name:` in the frontmatter, so the directory names it; quotes are stripped.
  assert.equal(got.find((c) => c.name === 'wizard').hint, 'what to provision');
  fs.rmSync(root, { recursive: true, force: true });
});

test('nested command files become namespaced names', () => {
  const { root, write } = fixture();
  write('config/commands/deploy.md', 'just a command, no frontmatter');
  write('config/commands/db/migrate.md', '---\ndescription: Run migrations.\n---\n');

  const got = listCommands({ roots: [path.join(root, 'config')] });
  assert.deepEqual(got.map((c) => c.name).sort(), ['db:migrate', 'deploy']);
  assert.equal(got.find((c) => c.name === 'deploy').description, '');
  fs.rmSync(root, { recursive: true, force: true });
});

test("a project's own skill shadows the user one and sorts first", () => {
  const { root, write } = fixture();
  write('config/skills/review/SKILL.md', '---\nname: review\ndescription: generic\n---\n');
  write('config/skills/other/SKILL.md', '---\nname: other\ndescription: generic\n---\n');
  write('project/.claude/skills/review/SKILL.md', '---\nname: review\ndescription: this repo\n---\n');

  const got = listCommands({ roots: [path.join(root, 'config')], cwd: path.join(root, 'project') });
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { name: 'review', description: 'this repo', hint: '', scope: 'project' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing directories are not an error', () => {
  assert.deepEqual(listCommands({ roots: ['/nope/does/not/exist'], cwd: '/nope/either' }), []);
  assert.deepEqual(listCommands(), []);
});
