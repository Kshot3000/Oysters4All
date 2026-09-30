/* Pearl Predict browser entry — explicit window assignment.
 * Built as a plain esbuild IIFE (no globalName): the esbuild `globalName`
 * wrapper assigns `var PearlPredict = <iife return>` AFTER the body runs and
 * would clobber this explicit assignment. See AGENTS.md lesson 2026-09-30. */
import * as core from "./predict-core.js";

window.PearlPredict = core;
