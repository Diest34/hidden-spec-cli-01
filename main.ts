// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Node 22, the standard library alone; run as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md sections 1 to 10: the command line, the output and exit
// codes, safe paths, format detection, three-tier line matching, unified
// diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits, and the
// all-or-nothing write. Every file is changed or nothing is.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A file as lines: its line break, its lines, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.ends ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Record that a move edit moved old to new; the output step decides whether it prints as R. */
  noteMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

/** One line of N (the replacement): a context line is written as the file's own matched line. */
interface NewLine {
  text: string;
  context: boolean;
  oIndex: number;
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in lines at one tier, from `from` on; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const want = o.map((l) => normLine(l, tier));
  const last = lines.length - o.length;
  for (let i = from; i <= last; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (normLine(lines[i + k]!, tier) !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(lines, o, t, from);
    if (eofOnly) pos = pos.filter((p) => p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Replace lines[pos .. pos+o.length) with N: context lines as the file's own, tier-2 re-indented. */
function applyMatch(lines: string[], o: string[], n: NewLine[], pos: number, tier: number): string[] {
  const out = lines.slice(0, pos);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWS(lines[pos]!);
    p = leadingWS(o[0]!);
  }
  for (const nl of n) {
    if (nl.context) {
      out.push(lines[pos + nl.oIndex]!);
    } else if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) {
      out.push(f + nl.text.slice(p.length));
    } else {
      out.push(nl.text);
    }
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const read = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = read(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = read(tree);
      const doc = splitDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.now.set(p, joinDoc(doc));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A hunk body line: ' ' context, '-' old, '+' new, '\\' no-newline marker. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  gitOld: string | null;
  gitNew: string | null;
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path a `--- ` or `+++ ` header line names, or null for /dev/null. */
function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** Parse a section's header (before its first hunk); returns the index it stops at. */
function parseUnifiedHeader(lines: string[], i: number, sec: Section): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      if (sec.hdrOld !== undefined) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) return i;
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      sec.hdrOld = headerPath(l);
      sec.hdrNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (HUNK_RE.test(l)) return i;
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('rename from ')) {
      if (sec.renOld === undefined) sec.renOld = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (sec.renNew === undefined) sec.renNew = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.newFile = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return i;
}

/** Parse a section's hunks (and ignore prose between them); returns the index it stops at. */
function parseUnifiedHunks(lines: string[], i: number, sec: Section): number {
  while (i < lines.length) {
    const l = lines[i]!;
    const m = HUNK_RE.exec(l);
    if (m !== null) {
      const a = parseInt(m[1]!, 10);
      i++;
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          if (b === '') body.push({ kind: ' ', text: '' });
          else body.push({ kind: b[0] as BodyLine['kind'], text: b.slice(1) });
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      sec.hunks.push({ a, body });
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    i++;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = GIT_RE.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { gitOld: m[1]!, gitNew: m[2]!, hdrOld: undefined, hdrNew: undefined, renOld: undefined, renNew: undefined, newFile: false, deletedFile: false, hunks: [] };
      i = parseUnifiedHeader(lines, i + 1, sec);
      i = parseUnifiedHunks(lines, i, sec);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { gitOld: null, gitNew: null, hdrOld: undefined, hdrNew: undefined, renOld: undefined, renNew: undefined, newFile: false, deletedFile: false, hunks: [] };
      i = parseUnifiedHeader(lines, i, sec);
      i = parseUnifiedHunks(lines, i, sec);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Apply one hunk to a file; returns the new file and the hunk's line delta. */
function applyHunk(doc: FileDoc, hunk: Hunk, strict: boolean, d: number, p: string): { doc: FileDoc; delta: number } {
  const o: string[] = [];
  const n: NewLine[] = [];
  let lastCtxOrPlus = -1;
  for (let bi = 0; bi < hunk.body.length; bi++) {
    const bl = hunk.body[bi]!;
    if (bl.kind === ' ') {
      o.push(bl.text);
      n.push({ text: bl.text, context: true, oIndex: o.length - 1 });
      lastCtxOrPlus = bi;
    } else if (bl.kind === '-') {
      o.push(bl.text);
    } else if (bl.kind === '+') {
      n.push({ text: bl.text, context: false, oIndex: -1 });
      lastCtxOrPlus = bi;
    }
  }
  const backslash = lastCtxOrPlus >= 0 && hunk.body[lastCtxOrPlus + 1] !== undefined && hunk.body[lastCtxOrPlus + 1]!.kind === '\\';
  if (o.length > 0) {
    const found = findTier(doc.lines, o, strict, 0, false);
    if (found === null) throw new Fail('no-match', p);
    const target = hunk.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.positions) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const newLines = applyMatch(doc.lines, o, n, best, found.tier);
    const ends = best + o.length === doc.lines.length ? !backslash : doc.ends;
    return { doc: { lines: newLines, br: doc.br, ends }, delta: n.length - o.length };
  }
  const at = Math.max(0, Math.min(hunk.a + d, doc.lines.length));
  const ins = n.map((x) => x.text);
  const newLines = [...doc.lines.slice(0, at), ...ins, ...doc.lines.slice(at)];
  const ends = at === doc.lines.length ? !backslash : doc.ends;
  return { doc: { lines: newLines, br: doc.br, ends }, delta: n.length };
}

/** One unified section as one edit (SPEC.md section 6). */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.hdrOld !== undefined ? sec.hdrOld : (sec.renOld !== undefined ? sec.renOld : sec.gitOld);
  const newPath = sec.hdrNew !== undefined ? sec.hdrNew : (sec.renNew !== undefined ? sec.renNew : sec.gitNew);
  const isCreate = oldPath === null || sec.newFile;
  const isDelete = !isCreate && (newPath === null || sec.deletedFile);
  if (isCreate) {
    const p = newPath ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let backslash = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi--) {
          if (body[bi]!.kind === '+') {
            backslash = body[bi + 1] !== undefined && body[bi + 1]!.kind === '\\';
            break outer;
          }
        }
      }
      for (const h of sec.hunks) for (const bl of h.body) if (bl.kind === '+') plus.push(bl.text);
      const text = plus.length === 0 ? '' : plus.join('\n') + (backslash ? '' : '\n');
      tree.now.set(p, text);
    };
  }
  if (isDelete) {
    const p = oldPath ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = oldPath ?? '';
  const q = newPath ?? '';
  const move = oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (move && !safe(q)) throw new Fail('unsafe', q);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (move && tree.get(q) !== null) throw new Fail('exists', q);
    let doc = splitDoc(before);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(doc, h, strict, d, p);
      doc = r.doc;
      d += r.delta;
    }
    const text = joinDoc(doc);
    if (move) {
      tree.now.set(p, null);
      tree.now.set(q, text);
      tree.noteMove(p, q);
    } else {
      tree.now.set(p, text);
    }
  };
}

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevReplace = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j > prevReplace; j--) {
        const t = lines[j]!.trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${i + 1}`);
      let eq = -1;
      let rep = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq >= 0) {
        for (let j = eq + 1; j < lines.length; j++) {
          if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
            rep = j;
            break;
          }
        }
      }
      if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevReplace = rep;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

/** One SEARCH/REPLACE block as one edit (SPEC.md section 7). */
function srEdit(b: SRBlock, strict: boolean): Edit {
  const p = b.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const text = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
      tree.now.set(p, text);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const doc = splitDoc(before);
    const found = findTier(doc.lines, b.oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const n: NewLine[] = b.newLines.map((t) => ({ text: t, context: false, oIndex: -1 }));
    const newLines = applyMatch(doc.lines, b.oldLines, n, pos, found.tier);
    tree.now.set(p, joinDoc({ lines: newLines, br: doc.br, ends: doc.ends }));
  };
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aAddEdit(p: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
    tree.now.set(p, text);
  };
}

function v4aDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

/** One V4A Update File section as one edit (SPEC.md section 8). */
function v4aUpdateEdit(p: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = splitDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(doc.lines, [ch.anchor], strict, cursor, false);
        if (found === null) throw new Fail('no-match', p);
        cursor = found.positions[0]! + 1;
      }
      const o: string[] = [];
      const n: NewLine[] = [];
      for (const bl of ch.body) {
        if (bl.kind === ' ') {
          o.push(bl.text);
          n.push({ text: bl.text, context: true, oIndex: o.length - 1 });
        } else if (bl.kind === '-') o.push(bl.text);
        else if (bl.kind === '+') n.push({ text: bl.text, context: false, oIndex: -1 });
      }
      if (o.length > 0) {
        const found = findTier(doc.lines, o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.positions[0]!;
        const newLines = applyMatch(doc.lines, o, n, pos, found.tier);
        doc = { lines: newLines, br: doc.br, ends: doc.ends };
        cursor = pos + n.length;
      } else {
        const at = ch.eof ? doc.lines.length : cursor;
        const ins = n.map((x) => x.text);
        doc = { lines: [...doc.lines.slice(0, at), ...ins, ...doc.lines.slice(at)], br: doc.br, ends: doc.ends };
        cursor = at + ins.length;
      }
    }
    const text = joinDoc(doc);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, text);
      tree.noteMove(p, moveTo);
    } else {
      tree.now.set(p, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last) {
        const s = lines[i]!;
        if (s === '') {
          fileLines.push('');
          i++;
          continue;
        }
        if (s.startsWith('+')) {
          fileLines.push(s.slice(1));
          i++;
          continue;
        }
        break;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(p, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && blank(lines[i]!)) i++;
      edits.push(v4aDeleteEdit(p));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      while (i < last) {
        const s = lines[i]!;
        if (s.startsWith('@@')) {
          const anchorText = s.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(cur);
          firstChunk = false;
          i++;
          continue;
        }
        if (s.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          firstChunk = false;
          i++;
          continue;
        }
        if (s === '' || s.startsWith(' ') || s.startsWith('-') || s.startsWith('+')) {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
            firstChunk = false;
          }
          if (s === '') cur.body.push({ kind: ' ', text: '' });
          else cur.body.push({ kind: s[0] as BodyLine['kind'], text: s.slice(1) });
          i++;
          continue;
        }
        break;
      }
      if (cur !== null) {
        while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.kind === ' ' && cur.body[cur.body.length - 1]!.text === '') cur.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (used.has(oldP) || used.has(newP)) continue;
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
