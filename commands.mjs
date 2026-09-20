// The slash commands and skills an agent can be sent, read from the same
// directories Claude Code itself reads: a config dir holds `skills/<name>/
// SKILL.md` and `commands/**/*.md`, and a project repeats both under `.claude`.
import fs from 'node:fs';
import path from 'node:path';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const CACHE_MS = 30000;
const cache = new Map(); // root -> { at, entries }

function field(block, name) {
  const m = block.match(new RegExp('^' + name + ':\\s*(.+)$', 'm'));
  if (!m) return '';
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function frontmatter(file) {
  let head;
  try { head = fs.readFileSync(file, 'utf8').slice(0, 4096); } catch { return null; }
  const m = head.match(FRONTMATTER);
  return m ? m[1] : '';
}

function walk(dir, base = dir, out = []) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, base, out);
    else if (it.name.endsWith('.md')) out.push({ file: p, rel: path.relative(base, p) });
  }
  return out;
}

// One entry per skill directory and per command file under `root`.
function scan(root) {
  const entries = [];

  let skillDirs = [];
  try { skillDirs = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }); } catch { /* none */ }
  for (const d of skillDirs) {
    if (!d.isDirectory()) continue;
    const fm = frontmatter(path.join(root, 'skills', d.name, 'SKILL.md'));
    if (fm === null) continue;
    entries.push({
      name: field(fm, 'name') || d.name,
      description: field(fm, 'description'),
      hint: field(fm, 'argument-hint'),
    });
  }

  for (const { file, rel } of walk(path.join(root, 'commands'))) {
    const fm = frontmatter(file) ?? '';
    entries.push({
      name: rel.replace(/\.md$/, '').split(path.sep).join(':'),
      description: field(fm, 'description'),
      hint: field(fm, 'argument-hint'),
    });
  }

  return entries;
}

function cached(root) {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.entries;
  const entries = scan(root);
  cache.set(root, { at: Date.now(), entries });
  return entries;
}

// Commands available to an agent: the configured roots, plus the `.claude` of
// the directory it runs in. A project entry shadows a user one of the same name.
export function listCommands({ roots = [], cwd = null } = {}) {
  const byName = new Map();
  for (const root of roots) {
    for (const e of cached(root)) byName.set(e.name, { ...e, scope: 'user' });
  }
  if (cwd) {
    for (const e of cached(path.join(cwd, '.claude'))) byName.set(e.name, { ...e, scope: 'project' });
  }
  return [...byName.values()].sort((a, b) =>
    (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1) || a.name.localeCompare(b.name));
}
