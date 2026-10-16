// Where the notes are kept: plain .md files in this plugin's own folder of Deck's config folder,
// one folder per project scope (`data\notes\<scope>\<title>.md`). The FILENAME is the title, and
// no `# Heading` goes into the body, so the folder reads the same in any markdown editor.
//
// Built on Deck's generic calls: configRead / configWrite / configDelete for a file (a name with
// an extension is that exact file, kept in this plugin's folder by its shim), and fsList /
// fsRename on dataDir() for what those cannot do. These were six notes-only commands in Deck.
import { configDelete, configRead, configWrite, dataDir, fsHomeDir, fsList, fsRename } from "../shim/bridge.js";

/** The scope for a thought that belongs to no project. */
export const GENERAL = "_general";

const RESERVED = new Set(["CON", "PRN", "AUX", "NUL",
  ..."123456789".split("").map((n) => `COM${n}`), ..."123456789".split("").map((n) => `LPT${n}`)]);

/**
 * One path segment safe to join: no traversal, no separators, nothing Windows rejects.
 *
 * Rejects rather than sanitises. The user typed the note's title, so a silent rewrite would leave
 * them looking for a file under a name they never chose.
 */
export function safeSegment(s: string): string {
  const t = s.trim();
  if (!t) throw new Error("name is empty");
  if ([...t].length > 120) throw new Error("name is too long");
  if (t === "." || t === "..") throw new Error("invalid name");
  const bad = [...t].find((c) => '/\\:*?"<>|'.includes(c) || c.charCodeAt(0) < 0x20);
  if (bad !== undefined) throw new Error(`name cannot contain ${JSON.stringify(bad)}`);
  // Windows refuses these outright, and a trailing dot or space silently becomes another file.
  if (t.endsWith(".") || t.endsWith(" ")) throw new Error("name cannot end with a dot or space");
  if (RESERVED.has(t.split(".")[0].toUpperCase())) throw new Error(`${t} is a reserved name`);
  return t;
}

const file = (scope: string, name: string) => `${safeSegment(scope)}/${safeSegment(name)}.md`;

export const notesRead = (scope: string, name: string) => configRead(file(scope, name));
/** An empty note is kept: a new tab starts empty, and only a JSON config is removed by "". */
export const notesWrite = (scope: string, name: string, text: string) => configWrite(file(scope, name), text);
export const notesDelete = (scope: string, name: string) => configDelete(file(scope, name));

/**
 * The notes in a scope, by title, A–Z. Syncthing conflict copies are left out, from when notes lived
 * in a synced vault: such a file is not a note the user made.
 */
export async function notesList(scope: string): Promise<string[]> {
  const entries = await fsList(`${await dataDir()}\\${safeSegment(scope)}`).catch(() => []);
  return entries
    .filter((e) => !e.dir && e.name.toLowerCase().endsWith(".md") && !e.name.includes(".sync-conflict-"))
    .map((e) => e.name.slice(0, -3))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Rename a note, which is what renaming its tab means. Refuses to overwrite another note. */
export async function notesRename(scope: string, from: string, to: string): Promise<void> {
  if (from === to) return;
  if ((await notesList(scope)).some((n) => n.toLowerCase() === to.trim().toLowerCase() && n !== from)) {
    throw new Error(`a note called ${to} already exists`);
  }
  // A read waits for every write queued before it, so the file is on disk under its old name
  // before it is renamed; otherwise a save still in the queue would land after, as a second file.
  await configRead(file(scope, from));
  await fsRename(`${await dataDir()}\\${safeSegment(scope)}\\${safeSegment(from)}.md`, `${safeSegment(to)}.md`);
}

/**
 * Which notes folder a working directory belongs to.
 *
 * A readable folder name (the directory's own name) rather than a slug of the full path, so the
 * folder is browsable by hand. Two checkouts sharing a name would collide, so each folder keeps a
 * hidden `.deck-cwd` marker naming the path that owns it, and a mismatch moves on to `name-2`,
 * `name-3`. An empty cwd, or the home directory, is the general scope.
 */
export async function notesScope(cwd: string): Promise<string> {
  const c = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const home = (await fsHomeDir().catch(() => "")).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!c || (home && home.toLowerCase() === c.toLowerCase())) return GENERAL;
  let base = (c.split("/").pop() ?? "").trim();
  if (!base) return GENERAL;
  // A slug when the folder's own name is not usable as a filename.
  try { base = safeSegment(base); } catch { base = base.replace(/[^a-zA-Z0-9_-]/g, "-"); }
  // Folder names compare without case: Windows does.
  const taken = new Set((await fsList(await dataDir()).catch(() => [])).filter((e) => e.dir).map((e) => e.name.toLowerCase()));
  for (let n = 1; n <= 20; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const marker = `${name}/.deck-cwd`;
    // Not there: claim it, so a later call for a DIFFERENT cwd of the same name steps past it.
    if (!taken.has(name.toLowerCase())) { await configWrite(marker, c); return name; }
    const owner = (await configRead(marker)).trim();
    // A folder from before the marker existed: adopt it rather than making a -2.
    if (!owner) { await configWrite(marker, c); return name; }
    if (owner.toLowerCase() === c.toLowerCase()) return name;
  }
  throw new Error("too many folders share this name");
}
