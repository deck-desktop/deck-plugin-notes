// Where each note was left, for this session: a tab you leave unmounts, and its note came back at the
// top; it comes back where you were instead.
//
// Kept as a place in the text, not a pixel offset: the line at the top of the view and how far into
// it, and the cursor. Live Markdown draws images, tables, code blocks and maths at their real height
// only once they render, and a long note is parsed in the background, so the lines above you keep
// changing height for a moment after the note opens. The place is put back on every frame until it
// holds, and again whenever the note's height changes, for a few seconds or until you scroll, click
// or type yourself. Holding for a few frames is not the end of it: the heights of a long note's
// images came in after that, moved the view several images on, and that place was then saved over
// the one you left.
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
  if (saved && saved.head <= v.state.doc.length) v.dispatch({ selection: { anchor: saved.head } });
  // Put back on every frame until it has held for a few in a row; a later change of height starts
  // this again (below) for as long as the place is being restored.
  const tick = () => {
    if (!saved || !restoring) return;
    still = putBack(v, saved) ? still + 1 : 0;
    if (still < 10) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  // Something above grew (an image, a table, the rest of the note parsed): put it back again.
  const grew = new ResizeObserver(() => {
    if (!saved || !restoring) return;
    still = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  });
  grew.observe(v.contentDOM);
  // Restoring ends after a few seconds, or as soon as you scroll, click or type.
  const stop = setTimeout(() => { restoring = false; }, 5000);

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
    clearTimeout(stop);
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
