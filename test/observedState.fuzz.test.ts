import { expect } from "chai";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ObservedState } from "../src/observedState.js";

// A seeded random-sequence check of ObservedState's invariant: when the files
// under a primed root change, at least one event the watcher would deliver for
// that change reports `isChanged === true` (an extra bump is allowed, a missed
// change is not). Each review round of #27 found a missed change that the
// hand-enumerated tests did not; this explores operation sequences instead.
//
// Ground truth is a snapshot of every file's content under the root (directory
// structure alone is not content, matching the "empty directories don't bump"
// rule). Events are the paths a recursive fs.watch reports: the touched path
// and its parent, except for the "roundtrip" operation: a directory renamed
// out, edited outside the tree and renamed back to its original path, which
// delivers events on the directory itself only. The fuzz normally runs in
// milliseconds, so the ctimes it sees are almost always inside the racy window:
// it exercises the re-check path, not the trusted-stamp comparison, which the
// separately aged tests pin.
//
// Deterministic: a fixed xorshift seed per run, so a failure names a seed that
// reproduces it.

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function snapshot(root: string): string {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    const entries = fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1));
    for (const e of entries) {
      const full = path.join(d, e.name);
      const r = rel + "/" + e.name;
      if (e.isDirectory()) walk(full, r);
      else out.push(r + " " + createHash("sha1").update(fs.readFileSync(full)).digest("hex"));
    }
  };
  walk(root, "");
  return out.join("|");
}

function listTree(root: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        dirs.push(full);
        walk(full);
      } else files.push(full);
    }
  };
  walk(root);
  return { files, dirs };
}

/** Structural check of the private parent index; returns a description of the first violation. */
function indexViolation(state: ObservedState): string | null {
  const s = state as any;
  const entries: Map<string, unknown> = s.entries;
  const children: Map<string, Set<string>> = s.children;
  const parentOf = (key: string): string => {
    if (key === "/") return "";
    const i = key.lastIndexOf("/");
    if (i < 0) return "";
    return i === 0 ? "/" : key.slice(0, i);
  };
  for (const k of entries.keys()) {
    if (k === "") continue;
    const set = children.get(parentOf(k));
    if (!set || !set.has(k)) return `entry ${k} not linked into its parent's set`;
  }
  for (const [p, set] of children) {
    if (set.size === 0) return `empty child set for ${p}`;
    if (p !== "") {
      const gp = children.get(parentOf(p));
      if (!gp || !gp.has(p)) return `parent node ${p} not linked`;
    }
    for (const c of set) {
      if (parentOf(c) !== p) return `child ${c} filed under ${p}`;
      if (!entries.has(c) && !children.has(c)) return `dangling child ${c}`;
    }
  }
  if (entries.size > s.maxEntries) return `size ${entries.size} > maxEntries ${s.maxEntries}`;
  return null;
}

interface RunResult {
  missed: string[];
  violations: string[];
  batches: number;
}

function run(seed: number, ops: number, batched: boolean): RunResult {
  const r = rng(seed * 7919 + 13);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const base = fs.realpathSync.native(os.tmpdir());
  const R = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "obsfuzz-r-")));
  const O = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "obsfuzz-o-")));
  const NAMES = ["a", "b", "c"];
  const log: string[] = [];
  const result: RunResult = { missed: [], violations: [], batches: 0 };
  let uniq = 0;
  try {
    for (let i = 0; i < 6; i++) {
      const d = path.join(R, pick(NAMES) + pick(NAMES));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, pick(NAMES) + ".txt"), pick(["x", "y"]));
    }
    for (let i = 0; i < 3; i++) {
      const d = path.join(O, "o" + pick(NAMES));
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, pick(NAMES) + ".txt"), pick(["x", "y"]));
    }
    const maxEntries = pick([2, 3, 5, 8, 1000]);
    const state = new ObservedState({ maxEntries });
    state.prime([R]);

    const inR = (p: string): boolean => p.startsWith(R + path.sep);
    const events = (...ps: string[]): string[] => {
      const out: string[] = [];
      for (const p of ps) for (const q of [p, path.dirname(p)]) if (inR(q) && !out.includes(q)) out.push(q);
      return out;
    };
    const rel = (p: string): string => p.slice(R.length);
    const outDirs = (): string[] =>
      fs.readdirSync(O).map((n) => path.join(O, n)).filter((p) => fs.statSync(p).isDirectory());
    const outFiles = (): string[] =>
      fs.readdirSync(O).map((n) => path.join(O, n)).filter((p) => fs.statSync(p).isFile());

    const step = (): string[] => {
      const { files, dirs } = listTree(R);
      const rdirs = [R, ...dirs];
      const kind = pick(["mkdir", "write", "edit", "rmfile", "rmdir", "out", "in", "outedit", "swap", "roundtrip", "fileOut", "fileIn"]);
      switch (kind) {
        case "mkdir": {
          const p = path.join(pick(rdirs), pick(NAMES) + pick(NAMES));
          if (fs.existsSync(p)) return [];
          fs.mkdirSync(p);
          log.push(`mkdir ${rel(p)}`);
          return events(p);
        }
        case "write": {
          const p = path.join(pick(rdirs), pick(NAMES) + ".txt");
          if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return [];
          fs.writeFileSync(p, pick(["x", "y", "z"]));
          log.push(`write ${rel(p)}`);
          return events(p);
        }
        case "edit": {
          if (!files.length) return [];
          const p = pick(files);
          fs.writeFileSync(p, pick(["x", "y", "z"]));
          log.push(`edit ${rel(p)}`);
          return events(p);
        }
        case "rmfile": {
          if (!files.length) return [];
          const p = pick(files);
          fs.unlinkSync(p);
          log.push(`rmfile ${rel(p)}`);
          return events(p);
        }
        case "rmdir": {
          if (!dirs.length) return [];
          const p = pick(dirs);
          fs.rmSync(p, { recursive: true });
          log.push(`rmdir ${rel(p)}`);
          return events(p);
        }
        case "out": {
          if (!dirs.length) return [];
          const p = pick(dirs);
          fs.renameSync(p, path.join(O, "u" + uniq++));
          log.push(`out ${rel(p)}`);
          return events(p);
        }
        case "in": {
          const od = outDirs();
          if (!od.length) return [];
          const p = path.join(pick(rdirs), "i" + uniq++);
          fs.renameSync(pick(od), p);
          log.push(`in ${rel(p)}`);
          return events(p);
        }
        case "outedit": {
          const of = listTree(O).files;
          if (!of.length) return [];
          fs.writeFileSync(pick(of), pick(["x", "y", "z"]));
          log.push("outedit");
          return [];
        }
        case "swap": {
          if (!dirs.length) return [];
          const p = pick(dirs);
          fs.renameSync(p, path.join(O, "s" + uniq++));
          fs.mkdirSync(p);
          fs.writeFileSync(path.join(p, pick(NAMES) + ".txt"), pick(["x", "y", "z"]));
          log.push(`swap ${rel(p)}`);
          return events(p);
        }
        case "roundtrip": {
          // Out, edit while outside, back to exactly the same path. Only the
          // directory's own events arrive (nothing on the parent).
          if (!dirs.length) return [];
          const p = pick(dirs);
          const tmp = path.join(O, "r" + uniq++);
          fs.renameSync(p, tmp);
          const inner = listTree(tmp);
          const action = pick(["change", "add", "remove"]);
          const content = "rt" + uniq++;
          let what: string;
          if (action === "change" && inner.files.length) {
            const f = pick(inner.files);
            fs.writeFileSync(f, content);
            what = `change ${f.slice(tmp.length)}`;
          } else if (action === "remove" && inner.files.length) {
            const f = pick(inner.files);
            fs.unlinkSync(f);
            what = `remove ${f.slice(tmp.length)}`;
          } else {
            const into = pick([tmp, ...inner.dirs]);
            const f = path.join(into, "n" + uniq++ + ".txt");
            fs.writeFileSync(f, content);
            what = `add ${f.slice(tmp.length)}`;
          }
          fs.renameSync(tmp, p);
          log.push(`roundtrip ${rel(p)} (${what})`);
          return [p];
        }
        case "fileOut": {
          if (!files.length) return [];
          const p = pick(files);
          fs.renameSync(p, path.join(O, "f" + uniq++ + ".txt"));
          log.push(`fileOut ${rel(p)}`);
          return events(p);
        }
        case "fileIn": {
          const of = outFiles();
          if (!of.length) return [];
          const p = path.join(pick(rdirs), "g" + uniq++ + ".txt");
          fs.renameSync(pick(of), p);
          log.push(`fileIn ${rel(p)}`);
          return events(p);
        }
      }
      return [];
    };

    for (let done = 0; done < ops; ) {
      const k = batched ? 1 + Math.floor(r() * 4) : 1;
      const before = snapshot(R);
      const pending: string[] = [];
      const start = log.length;
      for (let j = 0; j < k && done < ops; j++, done++) {
        for (const p of step()) if (!pending.includes(p)) pending.push(p);
      }
      const after = snapshot(R);
      const verdicts = pending.map((p) => state.isChanged(p));
      result.batches++;
      const v = indexViolation(state);
      if (v) result.violations.push(`seed ${seed}: ${v}`);
      if (before !== after && !verdicts.some(Boolean)) {
        result.missed.push(
          `seed ${seed} (maxEntries ${maxEntries}): [${log.slice(start).join("; ")}] events [${pending.map(rel).join(", ")}]`,
        );
      }
    }
  } finally {
    fs.rmSync(R, { recursive: true, force: true });
    fs.rmSync(O, { recursive: true, force: true });
  }
  return result;
}

describe("ObservedState random operation sequences", function () {
  this.timeout(120000);

  for (const [id, batched] of [
    ["O52", false],
    ["O53", true],
  ] as const) {
    it(`${id}: no missed change and a consistent index over 40 seeded sequences (${batched ? "batched" : "one op per event batch"})`, () => {
      const missed: string[] = [];
      const violations: string[] = [];
      let batches = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const res = run(seed, 60, batched);
        missed.push(...res.missed);
        violations.push(...res.violations);
        batches += res.batches;
      }
      expect(batches).to.be.greaterThan(0);
      expect(violations, violations.slice(0, 3).join("\n")).to.deep.equal([]);
      expect(missed, missed.slice(0, 3).join("\n")).to.deep.equal([]);
    });
  }
});
