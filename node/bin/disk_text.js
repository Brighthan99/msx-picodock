#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// disk_text.js — src/host/disk_text.py 의 Node 판. 하는 일은 ../src/disktools.js 에 있다.
import { textMain } from '../src/disktools.js';

process.exitCode = await textMain(['disk_text', ...process.argv.slice(2)]);
