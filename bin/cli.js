#!/usr/bin/env node
// Static, hand-written entry point - checked into git with the executable
// bit already set, so `pnpm run build` never needs to mutate file
// permissions on its output. It just re-exports the built CLI module.
import "../dist/cli.js";
