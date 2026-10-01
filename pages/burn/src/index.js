// Pearl Burn browser entry — explicit window assignment (no esbuild
// globalName: the IIFE-wrapper globalName clobbers explicit window.X
// assignment; see AGENTS.md).
import * as core from "./burn-core.js";
window.PearlBurn = { version: 1, ...core };
