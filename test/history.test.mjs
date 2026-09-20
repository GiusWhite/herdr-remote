import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../history.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-hist-'));
const screen = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join('\n');

test('a pane reused by another agent does not inherit the previous scrollback', () => {
  const dir = tmp();
  const pane = 'w1:p1';
  fs.writeFileSync(path.join(dir, encodeURIComponent(pane) + '.json'),
    JSON.stringify({ agent: 'terminal-A', lines: screen('agent-A', 2000).split('\n') }));

  const store = new HistoryStore({ dir });
  // Alternate-screen agents read back one viewport, far shorter than the
  // stored history, so nothing anchors and nothing looks like a restart.
  store.ingest(pane, screen('agent-B', 67), false, 'terminal-B');

  const { text } = store.tail(pane, 10000, 'text');
  assert.equal(text, screen('agent-B', 67));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('history stored before owners were tracked is not shown under an agent', () => {
  const dir = tmp();
  const pane = 'w1:p1';
  fs.writeFileSync(path.join(dir, encodeURIComponent(pane) + '.json'),
    JSON.stringify({ lines: screen('unknown-owner', 500).split('\n') }));

  const store = new HistoryStore({ dir });
  store.ingest(pane, screen('agent-B', 67), false, 'terminal-B');

  assert.equal(store.tail(pane, 10000, 'text').text, screen('agent-B', 67));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the same agent keeps extending its history across reads', () => {
  const dir = tmp();
  const pane = 'w1:p1';
  const store = new HistoryStore({ dir });
  const all = screen('agent-A', 120).split('\n');

  store.ingest(pane, all.slice(0, 80).join('\n'), true, 'terminal-A');
  store.ingest(pane, all.slice(40, 120).join('\n'), true, 'terminal-A');

  const { text, total } = store.tail(pane, 10000, 'text');
  assert.equal(total, 120);
  assert.equal(text, all.join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the owner is persisted so a restart still scopes the history', () => {
  const dir = tmp();
  const pane = 'w1:p1';
  const first = new HistoryStore({ dir });
  first.ingest(pane, screen('agent-A', 60), false, 'terminal-A');
  first.save();

  const saved = JSON.parse(fs.readFileSync(path.join(dir, encodeURIComponent(pane) + '.json'), 'utf8'));
  assert.equal(saved.agent, 'terminal-A');

  const after = new HistoryStore({ dir });
  assert.equal(after.tail(pane, 10000, 'text').text, screen('agent-A', 60));
  fs.rmSync(dir, { recursive: true, force: true });
});

// A live TUI redraws a spinner and an elapsed timer in the middle of the
// screen. Those lines are placed so that every contiguous anchor window the
// exact matcher tries contains one.
const redrawn = (tick) => Array.from({ length: 40 }, (_, i) =>
  i === 12 ? `✳ Thinking… (${tick}s)` : i === 25 ? `⏺ Running tool · ${tick}s` : `output line ${i}`).join('\n');

test('a screen redrawn with a ticking spinner is not appended again', () => {
  const dir = tmp();
  const pane = 'w1:p1';
  const store = new HistoryStore({ dir });

  // `truncated: true` — a partial read, so the "pane living a new life" escape
  // hatch cannot fire and the anchor has to carry it.
  store.ingest(pane, redrawn(1), true, 'terminal-A');
  store.ingest(pane, redrawn(2), true, 'terminal-A');
  store.ingest(pane, redrawn(3), true, 'terminal-A');

  const { total, text } = store.tail(pane, 10000, 'text');
  assert.equal(total, 40, 'the screen should replace itself, not stack up');
  assert.ok(!text.includes('history gap'));
  assert.ok(text.includes('(3s)'), 'the newest frame wins');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('output with no overlap still starts a new block after a gap marker', () => {
  const dir = tmp();
  const pane = 'w1:p1';
  const store = new HistoryStore({ dir });

  store.ingest(pane, screen('first', 40), true, 'terminal-A');
  store.ingest(pane, screen('unrelated', 40), true, 'terminal-A');

  const { text, total } = store.tail(pane, 10000, 'text');
  assert.equal(total, 81);
  assert.ok(text.includes('history gap'));
  assert.ok(text.includes('first line 0') && text.includes('unrelated line 0'));
  fs.rmSync(dir, { recursive: true, force: true });
});
