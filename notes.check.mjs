// node notes.check.mjs — a note's title and scope as file names.
//
// safeSegment is the only thing between a typed title and a path in Deck's config folder, so the
// traversal cases matter more than the cosmetic ones.
import assert from "node:assert/strict";
import { build } from "esbuild";

const entry = new URL("./src/store.ts", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
// The shim is Deck's at runtime; here it only needs to exist, and safeSegment never calls it.
const shim = { name: "shim", setup(b) { b.onResolve({ filter: /shim\/bridge\.js$/ }, () => ({ path: "shim", namespace: "shim" })); b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: "export const configRead=0,configWrite=0,configDelete=0,dataDir=0,fsHomeDir=0,fsList=0,fsRename=0;" })); } };
const out = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "node", plugins: [shim] });
const { safeSegment } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

for (const bad of ["", "  ", ".", "..", "../x", "a/b", "a\\b", "C:", "a*b", "a?b", "x.", "x. ", "CON", "con.md", "LPT1", "a\u0001b", "x".repeat(121)]) {
  assert.throws(() => safeSegment(bad), `${JSON.stringify(bad)} must be refused`);
}
for (const ok of ["Plan", "Release notes 1.4", "été", "ملاحظات", "deck-2", "_general"]) {
  assert.equal(safeSegment(ok), ok);
}
assert.equal(safeSegment("  Plan  "), "Plan", "trimmed, as the title is shown");

console.log("notes.check.mjs: ok");
