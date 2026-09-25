#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// build_disk.js — src/host/build_disk.py 의 Node 판. 하는 일은 ../src/diskmake.js 에 있다.
import { buildMain } from '../src/diskmake.js';

process.exitCode = await buildMain(['build_disk', ...process.argv.slice(2)]);
