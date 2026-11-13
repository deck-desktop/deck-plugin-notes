// Where each note was left, for this session: a tab you leave unmounts, and its note came back at the
// top; it comes back where you were instead.
//
// Kept as a place in the text, not a pixel offset: the line at the top of the view and how far into
// it, and the cursor. Live Markdown draws images, tables, code blocks and maths at their real height
// only once they render, and an image above you loads after the text, so a saved scrollTop lands
// somewhere else by the time the note has settled. The place is put back on every frame, and again
// whenever the note's height changes, until it has been still for a moment or a few seconds pass,
// or you scroll, click or type yourself.
import type { EditorView } from "@codemirror/view";

interface Spot { pos: number; offset: number; head: number }
const spots = new Map<string, Spot>();

/** The place at the top of the view: the line block there, and how far into it the view starts. */
function placeOf(v: EditorView): Spot {
  const h = v.scrollDOM.getBoundingClientRect().top - v.documentTop;
  const block = v.lineBlockAtHeight(Math.max(0, h));
  return { pos: block.from, offset: h - block.top, head: v.state.selection.main.head };
}

/** Scroll so that `s` is at the top again; true when it already was. */
function putBack(v: EditorView, s: Spot): boolean {
  if (s.pos > v.state.doc.length) return true;
  const block = v.lineBlockAt(s.pos);
  // From the scrolled content's top to the document's: the editor's padding above the first line.
  const above = v.documentTop - v.scrollDOM.getBoundingClientRect().top + v.scrollDOM.scrollTop;
  const want = Math.max(0, above + block.top + s.offset);
  if (Math.abs(v.scrollDOM.scrollTop - want) <= 1) return true;
  v.scrollDOM.scrollTop = want;
  return false;
}

/** Keep note `key`'s place in `v`, and put it back now. Returns the cleanup. */
export function keepSpot(v: EditorView, key: string): () => void {
  const saved = spots.get(key);
  let restoring = !!saved, raf = 0, still = 0;
  const until = Date.now() + 5000;
  if (saved && saved.head <= v.state.doc.length) v.dispatch({ selection: { anchor: saved.head } });
  const tick = () => {
    if (!saved || !restoring) return;
    // Done once it has held for a few frames in a row (the images have their height), or time is up.
    still = putBack(v, saved) ? still + 1 : 0;
    if (still >= 10 || Date.now() > until) restoring = false;
    else raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  // Something above grew (an image, a table) after the place had held: put it back again.
  const grew = new ResizeObserver(() => {
    if (!saved || !restoring) return;
    still = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  });
  grew.observe(v.contentDOM);

  // Saved as you scroll, click and type; not while putting it back, when the editor's own scrolling
  // would be saved over it, and never on unmount, when the editor is gone and reads 0.
  const keep = () => { if (!restoring) spots.set(key, placeOf(v)); };
  const yours = () => { restoring = false; };
  v.scrollDOM.addEventListener("scroll", keep, { passive: true });
  v.scrollDOM.addEventListener("wheel", yours, { passive: true });
  v.scrollDOM.addEventListener("mousedown", yours);
  v.scrollDOM.addEventListener("touchstart", yours, { passive: true });
  v.contentDOM.addEventListener("keydown", yours);
  v.contentDOM.addEventListener("keyup", keep);
  v.contentDOM.addEventListener("mouseup", keep);
  return () => {
    cancelAnimationFrame(raf);
    grew.disconnect();
    v.scrollDOM.removeEventListener("scroll", keep);
    v.scrollDOM.removeEventListener("wheel", yours);
    v.scrollDOM.removeEventListener("mousedown", yours);
    v.scrollDOM.removeEventListener("touchstart", yours);
    v.contentDOM.removeEventListener("keydown", yours);
    v.contentDOM.removeEventListener("keyup", keep);
    v.contentDOM.removeEventListener("mouseup", keep);
  };
}
