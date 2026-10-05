#!/usr/bin/env node
/** Runs fake-lmstudio.mjs as a standalone process (what fake-lms.mjs starts). Exits on POST /__close. */
import { startFakeLmStudio } from './fake-lmstudio.mjs';

const opts = JSON.parse(process.env.FAKE_LM_OPTS ?? '{}');
await startFakeLmStudio(Number(process.argv[2] ?? 1234), { ...opts, statePath: process.env.FAKE_LM_STATE, onClose: () => process.exit(0) });
