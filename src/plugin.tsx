// Project notes: a tab strip and a markdown editor, in a pane beside the terminals.
//
// Built into Deck until 1.1, now a plugin. Nothing about the data changed in the move: the notes
// are read and written through Deck's notes_* commands, which stay in Deck (a plugin cannot add
// native code), and the per-machine text size and tab order are in the same localStorage keys.
//
// The notes are plain .md files in Deck's config folder (%APPDATA%\Deck\notes\<scope>\), one
// file per note, so any markdown editor can open them. A backup carries them in full, which is
// the reason not to keep a token in one.
//
// A note's FILENAME is its title: renaming a tab renames the file, and there is no index file to
// drift out of step with the directory. Deliberately no folders, tags, search or preview — this
// is the drawer you scribble in, not a place for organising.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, StickyNote } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import {
  TabStrip, ConfirmDialog, NamePrompt, MarkdownToolbar, cmSurface, MarkdownLive,
  type TabItem, type ConfirmState, type NamePromptState,
} from "../shim/ui.js";
import {
  GENERAL, notesScope, notesList, notesRead, notesWrite, notesDelete, notesRename,
} from "./store";

const label = (scope: string) => (scope === GENERAL ? "General" : scope);

// Text size, in px. Per machine rather than per note or per project: it is about this screen and
// how far away you are sitting, which is the same reasoning as the graph's column width.
const ZOOM_KEY = "deck-notes-zoom";
const ZOOM_MIN = 10, ZOOM_MAX = 28, ZOOM_DEFAULT = 13;
const loadZoom = () => {
  const n = Number(localStorage.getItem(ZOOM_KEY));
  return Number.isFinite(n) && n >= ZOOM_MIN && n <= ZOOM_MAX ? n : ZOOM_DEFAULT;
};

/**
 * Which note was open in each scope, kept across mounts.
 *
 * The panel unmounts whenever you switch back to the terminals, and re-picking the first note
 * every time would lose your place in a long-lived scratch note. Module-level, like the graph's
 * store: this is view position, not something worth writing to disk.
 */
const lastOpen = new Map<string, string>();

// The tab order per scope, as dragged. Notes the order does not name yet (new, or made outside
// Deck) follow it alphabetically; names it holds that are gone are dropped on the next save.
// ponytail: per machine in localStorage, so a restored backup comes back alphabetical; move it
// into the notes folder if that ever matters.
const ORDER_KEY = "deck-notes-order";
const loadOrders = (): Record<string, string[]> => {
  try { return JSON.parse(localStorage.getItem(ORDER_KEY) ?? "{}") ?? {}; } catch { return {}; }
};
const saveOrder = (scope: string, names: string[]) => {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify({ ...loadOrders(), [scope]: names })); } catch { /* private mode */ }
};
const ordered = (scope: string, list: string[]) => {
  const want = loadOrders()[scope] ?? [];
  const known = want.filter((n) => list.includes(n));
  return [...known, ...list.filter((n) => !known.includes(n))];
};

// A pane view only, with no tab of its own: notes belong to a workspace's folder, which a pane
// is given and a whole-window tab is not.
export function PaneView({ cwd }: { cwd: string }) {
  // "" until notes_scope answers; every read and write is keyed by it, so nothing runs before.
  const [scope, setScope] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [renaming, setRenaming] = useState<NamePromptState | null>(null);
  const [err, setErr] = useState("");
  // The live CodeMirror instance, so the toolbar can dispatch into it. Null until the editor
  // mounts, and again between notes — the buttons disable themselves meanwhile.
  const [cmView, setCmView] = useState<EditorView | null>(null);
  // Wrapped once per editor instance rather than per render: a fresh object every render would
  // change the toolbar's props on every keystroke.
  const surface = useMemo(() => (cmView ? cmSurface(cmView) : null), [cmView]);
  const [zoom, setZoom] = useState(loadZoom);
  useEffect(() => { try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* private mode */ } }, [zoom]);
  // 0 resets, which is what the size readout in the toolbar does when clicked.
  const nudgeZoom = useCallback((d: number) => setZoom((z) =>
    d === 0 ? ZOOM_DEFAULT : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + d))), []);

  const current = scope;

  // Resolve the project scope once per cwd. notes_scope also claims the folder and writes its
  // .deck-cwd marker, so two checkouts with the same folder name do not share notes.
  useEffect(() => {
    let alive = true;
    notesScope(cwd).then((s) => { if (alive) setScope(s); })
      .catch(() => { if (alive) { setScope(GENERAL); setErr("Could not resolve a notes folder; showing General."); } });
    return () => { alive = false; };
  }, [cwd]);

  // What is on disk for the open note. Every loader sets this alongside setText, so the autosave
  // below only fires for text the user actually typed.
  const lastSaved = useRef<string>("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The note list for whichever scope is showing. Ticketed: switching scope twice quickly must
  // not let the first listing land on top of the second.
  const listTicket = useRef(0);
  const reload = useCallback(async (scopeName: string) => {
    const ticket = ++listTicket.current;
    setLoading(true);
    const list = await notesList(scopeName).catch((e) => { console.warn("[notes] list failed", e); return [] as string[]; });
    if (ticket !== listTicket.current) return;
    setNames(ordered(scopeName, list));
    const want = lastOpen.get(scopeName);
    const next = want && list.includes(want) ? want : (list[0] ?? null);
    const body = next ? await notesRead(scopeName, next).catch((e) => { console.warn("[notes] read failed", e); return ""; }) : "";
    if (ticket !== listTicket.current) return;
    setActive(next);
    // The loader owns the baseline. Without this the autosave effect compares freshly-read
    // content against the PREVIOUS note's text and writes it straight back — a needless disk
    // write per switch, and a window in which an edit made outside Deck gets overwritten.
    lastSaved.current = body;
    setText(body);
    setLoading(false);
  }, []);

  // Write out whatever is on screen, if it differs from disk, and cancel the pending timer.
  // Anything that navigates away from a note calls this: switching tab, adding one, changing
  // scope. Reads the refs rather than taking arguments so a stale closure cannot flush the
  // wrong note into the wrong file.
  const openRef = useRef({ scope: "", name: "", text: "" });
  openRef.current = { scope: current, name: active ?? "", text };
  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const { scope: sc, name, text: body } = openRef.current;
    if (!sc || !name || body === lastSaved.current) return;
    lastSaved.current = body;
    await notesWrite(sc, name, body).catch((e) => console.warn("[notes] save failed", e));
  }, []);

  // Scope changed (project ↔ General). Flush first: the note on screen belongs to the scope
  // being left, and reload() would otherwise replace it before the debounce ever fired.
  const prevScope = useRef("");
  useEffect(() => {
    if (!current) return;
    const leaving = prevScope.current && prevScope.current !== current;
    prevScope.current = current;
    void (leaving ? flush() : Promise.resolve()).then(() => reload(current));
  }, [current, reload, flush]);

  // Autosave. lastSaved is claimed BEFORE the write, not after: the same ordering bug that made
  // the Startup Manager appear to lose edits. Debounced at 600ms so typing is not a disk write
  // per keystroke.
  useEffect(() => {
    if (!active || !current || loading) return;
    if (text === lastSaved.current) return;
    clearTimeout(saveTimer.current);
    const body = text, name = active, sc = current;
    saveTimer.current = setTimeout(() => {
      lastSaved.current = body;
      notesWrite(sc, name, body).catch((e) => setErr(String(e)));
    }, 600);
  }, [text, active, current, loading]);

  const open = async (name: string) => {
    if (!current) return;
    // An edit that has not hit its debounce yet must not be dropped by the switch.
    await flush();
    const body = await notesRead(current, name).catch((e) => { console.warn("[notes] read failed", e); return ""; });
    lastOpen.set(current, name);
    setActive(name);
    lastSaved.current = body; // baseline first, so the effect below sees nothing to write
    setText(body);
  };

  const add = async () => {
    if (!current) return;
    // Untitled, Untitled 2, … — the same dedupe shape as a duplicated request.
    let name = "Untitled";
    for (let n = 2; names.includes(name); n++) name = `Untitled ${n}`;
    try {
      // Creating a note is also navigating away from the current one.
      await flush();
      await notesWrite(current, name, "");
      setNames((l) => { const next = [...l, name]; saveOrder(current, next); return next; });
      lastOpen.set(current, name);
      setActive(name);
      lastSaved.current = "";
      setText("");
    } catch (e) { setErr(String(e)); }
  };

  const remove = (name: string) => setConfirm({
    title: `Delete "${name}"?`,
    body: "The note is deleted from this machine.",
    confirmLabel: "Delete",
    onConfirm: () => {
      if (!current) return;
      // A debounced write still pending for this note would recreate the file moments after it
      // is deleted, which reads as the delete silently failing.
      clearTimeout(saveTimer.current);
      void notesDelete(current, name)
        // Only when the note being deleted is the open one — otherwise this jumps away from
        // whatever the user is actually looking at.
        .then(() => { if (name === active) lastOpen.delete(current); return reload(current); })
        .catch((e) => setErr(String(e)));
    },
  });

  const rename = (name: string) =>
    setRenaming({ title: "Rename note", initial: name, confirmLabel: "Rename", onSave: (to) => void doRename(name, to) });

  const doRename = async (name: string, to: string) => {
    if (to === name || !current) return;
    // Same reasoning as delete: the pending write names the OLD file, which is about to
    // not exist. Flush it under that name first, so the rename carries the edit across.
    clearTimeout(saveTimer.current);
    try {
      if (name === active && text !== lastSaved.current) {
        await notesWrite(current, name, text);
        lastSaved.current = text;
      }
      await notesRename(current, name, to);
      saveOrder(current, names.map((n) => (n === name ? to : n)));
      if (name === active) lastOpen.set(current, to);
      await reload(current);
    } catch (e) { setErr(String(e)); }
  };

  const tabs: TabItem[] = names.map((n) => ({
    id: n, title: n, closeTitle: "Delete note",
  }));

  return (
    // No frame or background of its own: the pane draws both, the same as for the Editor beside
    // it. A card here was a second border inside the pane, in a different shade from its neighbours.
    <div className="flex min-h-0 flex-1 flex-col overflow-clip">
      <TabStrip chip
        tabs={tabs} activeId={active}
        onSelect={(id) => void open(id)}
        onClose={remove}
        onDoubleClick={(id) => void rename(id)}
        onReorder={(from, to) => setNames((l) => {
          const next = l.filter((n) => n !== from);
          next.splice(l.indexOf(to), 0, from);
          if (current) saveOrder(current, next);
          return next;
        })}
        onAdd={() => void add()} addTitle="New note"
      />
      {err && (
        <div className="shrink-0 cursor-pointer px-3 py-1 text-[11.5px] text-red-400" title="Dismiss"
          onClick={() => setErr("")}>{err}</div>
      )}
      {loading ? (
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-text-muted">
          <Loader2 size={14} className="mr-2 animate-spin" /> Loading notes…
        </div>
      ) : active ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <MarkdownToolbar surface={surface} zoom={zoom} onZoom={nudgeZoom} />
          {/* Ctrl+wheel zooms, like every editor. Bound here rather than on the window so it
              only applies while the pointer is over the notes text. No preventDefault: React's
              wheel listener is passive, so the call would only warn — and Tauri leaves
              zoomHotkeysEnabled off, so there is no browser page zoom to suppress anyway. */}
          <div
            className="min-h-0 flex-1"
            onWheel={(e) => { if (e.ctrlKey) nudgeZoom(e.deltaY < 0 ? 1 : -1); }}
            style={{ fontSize: zoom }}
          >
            {/* Keyed by scope+name: MarkdownLive builds its CodeMirror state once and thereafter
                only patches the doc, so remounting per note is what gives each its own undo
                history. NOT keyed on zoom — that would throw the history away on every step. */}
            <MarkdownLive key={`${current}/${active}`}
              value={text} onChange={setText} onView={setCmView} flush fontSize={zoom} />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex max-w-sm items-start gap-2.5 rounded-lg border border-subtle px-3 py-3 text-[12px] leading-relaxed text-text-muted"
            style={{ background: "var(--bg-elev)" }}>
            <StickyNote size={16} className="mt-0.5 shrink-0" />
            <div className="flex flex-col items-start gap-2">
              <span>No notes in {label(current || "…")} yet. Each note is a plain markdown file, saved as you type.</span>
              <button onClick={() => void add()}
                className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-white transition hover:brightness-110"
                style={{ background: "var(--accent)" }}>
                <Plus size={13} /> Write one
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
      <NamePrompt state={renaming} onClose={() => setRenaming(null)} />
    </div>
  );
}
