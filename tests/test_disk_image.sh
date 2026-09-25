#!/bin/sh
# No disk image is committed - serve.sh builds one on first run - so this makes
# a throwaway and checks that what comes out of dist/disk/system/ actually lands
# on it. That is the thing worth testing: a rebuilt .COM that never reaches the
# disk builder is a file people are handed stale.
# The image is read directly rather than mounted: mounting needs privileges on
# Linux and leaves the host writing to a file the MSX may be serving.
set -e
cd "$(dirname "$0")/.."

IMG="${TMPDIR:-/tmp}/pdtest-disk-image.img"
rm -f "$IMG"
# 9m, not 128m: nothing here cares about free space, and the small one is built
# and thrown away in a fraction of the time. 9m is the floor, not a round number
# - below it a 2KB-cluster volume has fewer than 4085 clusters and is FAT12,
# which these tools refuse.
node dist/node/bin/build_disk.js bare dist/disk 9m "$IMG" PICODOCK >/dev/null || {
  echo "  FAIL could not build a disk image from dist/disk/system/"
  exit 1; }
export IMG
trap 'rm -f "$IMG"' EXIT

exec node --input-type=module - <<'JS'
import fs from 'node:fs';
import path from 'node:path';

// The one just built, not picodock.img: that is whatever the person running this
// has put on it, and holding that to system/ would fail for them.
const IMG = process.env.IMG, SRC = 'dist/disk/system';

// Name -> size, from the FAT16 root directory.
//
// Located through the MBR and the BPB rather than by scanning for something
// that looks like a directory. The scan version of this worked until the disk
// had enough files to be interesting, then reported one of them missing when
// it was not - a test that cries wolf is worse than no test.
function rootEntries(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(0x100000);
  fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);

  const start = head.readUInt32LE(446 + 8);                 // first partition LBA
  const bpb = head.subarray(start * 512, start * 512 + 512);
  const bytesPerSec = bpb.readUInt16LE(11);
  const reserved = bpb.readUInt16LE(14);
  const nFats = bpb[16];
  const rootMax = bpb.readUInt16LE(17);
  const fatSecs = bpb.readUInt16LE(22);
  if (bytesPerSec !== 512 || !rootMax) {
    console.log(`  FAIL ${file} does not look like the FAT16 we write`);
    process.exit(1);
  }

  const root = (start + reserved + nFats * fatSecs) * 512;
  const out = new Map();
  for (let i = 0; i < rootMax; i++) {
    const e = head.subarray(root + i * 32, root + i * 32 + 32);
    if (e[0] === 0x00) break;                                // end of directory
    if (e[0] === 0xE5 || (e[11] & 0x0F) === 0x0F) continue;  // deleted, or a VFAT part
    const name = e.subarray(0, 8).toString('latin1').trim();
    const ext = e.subarray(8, 11).toString('latin1').trim();
    out.set(ext ? `${name}.${ext}` : name, e.readUInt32LE(28));
  }
  return out;
}

const onDisk = rootEntries(IMG);
const wanted = new Map(fs.readdirSync(SRC).filter((f) => !f.startsWith('.')).sort()
  .map((f) => [f, fs.statSync(path.join(SRC, f)).size]));

// Everything else on the image is somebody else's business: what the user put in
// user-files/, and what the MSX itself wrote there - SofaRun makes a SAVES
// directory the first time it runs. This check exists to catch a system file
// that went stale, not to police a disk that is in use.

let fail = 0;
for (const [name, size] of wanted) {
  const got = onDisk.get(name.toUpperCase());
  if (got === undefined) {
    console.log(`  FAIL ${name} is in ${SRC}/ but not on the image`);
    fail = 1;
  } else if (got !== size) {
    console.log(`  FAIL ${name}: image has ${got} bytes, ${SRC}/ has ${size}`);
    console.log('       the disk builder is not picking that file up -');
    console.log('       check node/src/diskmake.js (build_disk.js) and stage_dist.sh');
    fail = 1;
  } else {
    console.log(`  OK   ${name}  ${size}`);
  }
}

const upper = new Set([...wanted.keys()].map((n) => n.toUpperCase()));
const extra = [...onDisk.keys()].filter((n) => !upper.has(n)).sort();
if (extra.length)
  console.log('  --   also on the image (yours, or the MSX\'s): '
    + extra.slice(0, 8).join(', ') + (extra.length > 8 ? ' ...' : ''));

if (!fail) console.log('  all passed');
process.exit(fail);
JS
