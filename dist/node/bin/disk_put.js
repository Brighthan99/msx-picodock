#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-only
// disk_put.js — src/host/disk_put.py 의 Node 판. 하는 일은 ../src/disktools.js 에 있다.
import { putMain } from '../src/disktools.js';

process.exitCode = await putMain(['disk_put', ...process.argv.slice(2)]);
