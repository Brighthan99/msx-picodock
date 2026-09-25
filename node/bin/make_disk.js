#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// make_disk.js — src/host/make_disk.py 의 Node 판. 하는 일은 ../src/diskmake.js 에 있다.
import { makeDisk } from '../src/diskmake.js';

process.exitCode = makeDisk(['make_disk', ...process.argv.slice(2)]);
