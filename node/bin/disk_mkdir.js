#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// disk_mkdir.js — src/host/disk_mkdir.py 의 Node 판. 하는 일은 ../src/disktools.js 에 있다.
import { mkdirMain } from '../src/disktools.js';

process.exitCode = await mkdirMain(['disk_mkdir', ...process.argv.slice(2)]);
