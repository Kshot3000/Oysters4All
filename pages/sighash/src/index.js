// Pearl Sighash Studio browser entry — explicit window assignment (no esbuild
// globalName: the IIFE-wrapper globalName clobbers explicit window.X
// assignment; see AGENTS.md).
import * as core from "./sighash-core.js";
import { BIP341_KEYPATH } from "./vectors-bip341.js";
import { BIP340_VECTORS } from "./vectors-bip340.js";
window.PearlSighash = { version: 1, ...core, vectors: { BIP341_KEYPATH, BIP340_VECTORS } };
