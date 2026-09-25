#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// disk_mv.js — src/host/disk_mv.py 의 Node 판. 하는 일은 ../src/disktools.js 에 있다.
import { mvMain } from '../src/disktools.js';

process.exitCode = await mvMain(['disk_mv', ...process.argv.slice(2)]);
