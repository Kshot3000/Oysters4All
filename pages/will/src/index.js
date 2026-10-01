// Pearl Will browser entry — explicit window assignment (no esbuild
// globalName: the IIFE-wrapper globalName clobbers explicit window.X
// assignment; see AGENTS.md).
import * as core from "./will-core.js";
window.PearlWill = { version: 1, ...core };
