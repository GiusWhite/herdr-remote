// Per-pane scrollback history, stitched from successive herdr reads.
// herdr's pane.read returns at most 1000 lines; consecutive reads overlap, so
// anchoring each new tail inside the stored history extends it indefinitely.
import fs from 'node:fs';
import path from 'node:path';

const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[\s\S]?/g;
const ANCHOR_LINES = 30;
const ANCHOR_OFFSETS = [0, 5, 10, 20, 50, 100, 200, 400, 700];
const GAP_MARKER = '\x1b[2m── history gap: output arrived faster than it was read ──\x1b[0m';

export const stripAnsi = (s) => s.replace(ANSI_RE, '');
const key = (s) => stripAnsi(s).replace(/\s+$/, '');

export class HistoryStore {
  constructor({ dir, maxLines = 10000, saveMs = 30000 }) {
    this.dir = dir;
    this.maxLines = maxLines;
    this.saveMs = saveMs;
    this.panes = new Map(); // pane_id -> { raw: string[], keys: string[], agent, dirty }
    this.saveTimer = null;
  }

  file(paneId) { return path.join(this.dir, encodeURIComponent(paneId) + '.json'); }

  // `agentId` is the terminal that owns the pane right now. herdr reuses pane
  // ids, so history kept under a different owner belongs to another
  // conversation and is dropped rather than shown under this one.
  entry(paneId, agentId) {
    let e = this.panes.get(paneId);
    if (!e) {
      e = { raw: [], keys: [], agent: null, dirty: false };
      try {
        const saved = JSON.parse(fs.readFileSync(this.file(paneId), 'utf8'));
        if (Array.isArray(saved.lines)) {
          e.raw = saved.lines; e.keys = saved.lines.map(key); e.agent = saved.agent ?? null;
        }
      } catch { /* no saved history */ }
      this.panes.set(paneId, e);
    }
    if (agentId && e.agent !== agentId) {
      if (e.agent !== null || e.raw.length) { e.raw = []; e.keys = []; e.dirty = true; }
      e.agent = agentId;
    }
    return e;
  }

  // Merge one read result (lines of `text`, `truncated` from herdr) into the
  // pane's history. Returns the entry.
  ingest(paneId, text, truncated, agentId) {
    const e = this.entry(paneId, agentId);
    const tail = (text ?? '').replace(/\r/g, '').split('\n');
    const tailKeys = tail.map(key);
    if (!e.raw.length) return this.replace(e, tail, tailKeys);

    const pos = findAnchor(e.keys, tailKeys);
    if (pos !== -1) {
      e.raw = e.raw.slice(0, pos).concat(tail);
      e.keys = e.keys.slice(0, pos).concat(tailKeys);
    } else if (!truncated && tail.length >= e.raw.length) {
      // herdr holds the whole buffer, it is at least as long as ours and none
      // of it matches: this pane id is living a new life (restart/restore).
      return this.replace(e, tail, tailKeys);
    } else {
      // A shorter unmatched read is an alternate-screen viewport that jumped
      // further than the anchor can bridge: keep what we have, mark the gap.
      e.raw.push(GAP_MARKER, ...tail);
      e.keys.push(key(GAP_MARKER), ...tailKeys);
    }
    this.trim(e);
    this.markDirty(e);
    return e;
  }

  replace(e, raw, keys) {
    e.raw = raw; e.keys = keys;
    this.trim(e);
    this.markDirty(e);
    return e;
  }

  trim(e) {
    const over = e.raw.length - this.maxLines;
    if (over > 0) { e.raw.splice(0, over); e.keys.splice(0, over); }
  }

  // Lines [start, end) of a pane's history plus its total length.
  slice(paneId, start, end, format = 'ansi') {
    const e = this.entry(paneId);
    const total = e.raw.length;
    const s = Math.max(0, Math.min(start, total));
    const en = Math.max(s, Math.min(end, total));
    let lines = e.raw.slice(s, en);
    if (format === 'text') lines = lines.map(stripAnsi);
    return { text: lines.join('\n'), start: s, end: en, total };
  }

  tail(paneId, lines, format) {
    const total = this.entry(paneId).raw.length;
    return this.slice(paneId, Math.max(0, total - lines), total, format);
  }

  markDirty(e) {
    e.dirty = true;
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), this.saveMs).unref();
  }

  // Synchronous like the activity file: safe from the exit handler.
  save() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { return; }
    for (const [paneId, e] of this.panes) {
      if (!e.dirty) continue;
      e.dirty = false;
      try {
        const f = this.file(paneId);
        fs.writeFileSync(f + '.tmp', JSON.stringify({ agent: e.agent, lines: e.raw }));
        fs.renameSync(f + '.tmp', f);
      } catch { /* best effort */ }
    }
  }

  // Drop history files nobody touched for `maxAgeMs`: their pane ids are gone.
  prune(maxAgeMs) {
    let files;
    try { files = fs.readdirSync(this.dir); } catch { return; }
    const cutoff = Date.now() - maxAgeMs;
    for (const f of files) {
      const p = path.join(this.dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

// Locate where `tail` begins inside `hist`, comparing ANSI-stripped keys.
// Tries an anchor window at several offsets into the tail (the very top lines
// of a read may have been redrawn since we stored them), searching from the
// end of history backwards so the most recent occurrence wins. Returns the
// history index corresponding to tail[0], or -1.
function findAnchor(hist, tail) {
  // Viewport-sized reads (alternate-screen TUIs) get a shorter window so a
  // scroll of most of a screen between two reads still anchors.
  const len = Math.min(ANCHOR_LINES, Math.max(8, Math.floor(tail.length / 3)));
  for (const off of ANCHOR_OFFSETS) {
    if (off + len > tail.length) break;
    const anchor = tail.slice(off, off + len);
    if (!distinctive(anchor)) continue;
    for (let i = hist.length - len; i >= 0; i--) {
      let ok = true;
      for (let j = 0; j < len; j++) {
        if (hist[i + j] !== anchor[j]) { ok = false; break; }
      }
      if (ok) return Math.max(0, i - off);
    }
  }
  // Very short reads (pane younger than the anchor window): whole-tail match.
  if (tail.length < 8 && tail.length > 2 && distinctive(tail)) {
    for (let i = hist.length - tail.length; i >= 0; i--) {
      let ok = true;
      for (let j = 0; j < tail.length && ok; j++) if (hist[i + j] !== tail[j]) ok = false;
      if (ok) return i;
    }
  }
  return -1;
}

// An anchor of blank lines or repeated separators matches everywhere.
function distinctive(lines) {
  const nonBlank = lines.filter((l) => l.trim().length > 0);
  return nonBlank.length >= 3 && new Set(nonBlank).size >= 3;
}
