#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// stage_user_files.js — src/host/stage_user_files.py 의 Node 판. 하는 일은 ../src/diskmake.js 에 있다.
import { stageMain } from '../src/diskmake.js';

process.exitCode = await stageMain(['stage_user_files', ...process.argv.slice(2)]);
