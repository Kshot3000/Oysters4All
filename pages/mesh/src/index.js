// Pearl Mesh browser entry — explicit namespace export.
// Bundled by build.mjs as a plain IIFE (no globalName wrapper); the explicit
// window assignment below is the single source of the public name.
import * as core from "./mesh-core.js";

window.PearlMesh = core;
