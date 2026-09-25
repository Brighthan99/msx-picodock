#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// disk_rm.js — src/host/disk_rm.py 의 Node 판. 하는 일은 ../src/disktools.js 에 있다.
import { rmMain } from '../src/disktools.js';

process.exitCode = await rmMain(['disk_rm', ...process.argv.slice(2)]);
