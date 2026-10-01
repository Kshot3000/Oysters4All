// Pearl Pact browser entry — explicit window assignment (no esbuild
// globalName: the IIFE-wrapper globalName clobbers explicit window.X
// assignment; see AGENTS.md).
import * as core from "./pact-core.js";
window.PearlPact = { version: 1, ...core };
