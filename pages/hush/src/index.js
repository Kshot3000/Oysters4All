// Pearl Hush browser entry — explicit window assignment (no esbuild
// globalName: the IIFE-wrapper globalName clobbers explicit window
// assignment; see AGENTS.md).
//
// NOTE: the BIP-352 test vectors (src/vectors-bip352.json) are NOT bundled:
// the bundle is code only. Tests load the vectors with fs.readFileSync.
import * as core from "./hush-core.js";
window.PearlHush = { version: 1, ...core };
