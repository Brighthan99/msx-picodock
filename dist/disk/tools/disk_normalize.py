#!/usr/bin/env python3
"""disk_normalize.py - make an image look the same on the Mac and on the MSX.

    ./dist/disk/tools/disk_normalize.py picodock.img

Three things macOS leaves behind make a FAT volume read differently on each side:

  * **lowercase hint bits** (NT byte, offset 0x0C bits 3/4). macOS sets them when
    the original name was lowercase and renders `SOFARUN` as `sofarun`. MSX-DOS
    ignores them, so the same directory reads differently on each side.
  * **LFN records** - the long-name entries preceding a short entry. Nextor
    cannot read them, so the MSX only sees the mangled alias (`SPACEM~1.COM`).
    They also eat root directory slots, of which there are 512.
  * **AppleDouble sidecars and metadata folders** (`._NAME`, `.fseventsd`,
    `.Trashes`, ...). Invisible on the Mac, plainly visible in DIR on the MSX.

This clears the hint bits, drops the LFN records, and deletes the metadata,
freeing its clusters. Names longer than 8.3 stay mangled - that is FAT's limit -
but what you see on the Mac is then what the MSX sees.

Runs on an **unmounted** image. disk_put.sh and the disk server (after you eject
a Finder session) do this automatically.
"""

import sys

SECTOR = 512
ATTR_LFN = 0x0F
ATTR_DIR = 0x10
ATTR_VOLUME = 0x08
NT_LOWERCASE = 0x18       # bit3 = base lowercase, bit4 = extension lowercase
FREE = 0xE5

MACOS_DIRS = {".fseventsd", ".Trashes", ".Spotlight-V100", ".TemporaryItems",
              ".DocumentRevisions-V100", ".apDisk"}


def u16(b, o):
    return int.from_bytes(b[o:o + 2], "little")


# AppleDouble files begin with this magic (followed by version 00 02 00 00).
APPLEDOUBLE_MAGIC = b"\x00\x05\x16\x07"


def is_macos_junk(fat, long_name, short_name, is_dir, first_cluster):
    """AppleDouble sidecars and the metadata folders macOS creates on FAT.

    The long name is the reliable signal: `._NAME` and `.fseventsd` are not valid
    8.3 names, so macOS always writes an LFN for them.

    An entry whose LFN was already stripped (by an older version of this tool)
    survives only as something like `_NAME~1.COM`, which is indistinguishable
    from a legitimate file called `_NAME.COM`. Guessing from the name would
    delete real data, so those are identified by their **contents** instead -
    AppleDouble has a fixed magic number.
    """
    if long_name.startswith("._") or long_name == ".DS_Store":
        return True
    if long_name in MACOS_DIRS:
        return True

    if not long_name and not is_dir and short_name.startswith("_") and first_cluster:
        pos = (fat.data_start + (first_cluster - 2) * fat.spc) * SECTOR
        fat.f.seek(pos)
        return fat.f.read(4) == APPLEDOUBLE_MAGIC

    return False


class Fat:
    def __init__(self, f):
        f.seek(0)
        mbr = f.read(SECTOR)
        self.part = int.from_bytes(mbr[0x1BE + 8:0x1BE + 12], "little") \
            if mbr[510:512] == b"\x55\xAA" else 0

        f.seek(self.part * SECTOR)
        b = f.read(SECTOR)
        self.bps = u16(b, 11)
        self.spc = b[13]
        self.reserved = u16(b, 14)
        self.nfats = b[16]
        self.root_entries = u16(b, 17)
        self.fatsz = u16(b, 22)
        if not (self.bps == SECTOR and self.spc and self.fatsz):
            raise ValueError("not a FAT16 image this tool understands")

        self.fat_start = self.part + self.reserved
        self.root_start = self.fat_start + self.nfats * self.fatsz
        self.root_sectors = (self.root_entries * 32 + SECTOR - 1) // SECTOR
        self.data_start = self.root_start + self.root_sectors
        self.f = f

    # --- FAT access --------------------------------------------------------
    def get(self, cluster):
        self.f.seek(self.fat_start * SECTOR + cluster * 2)
        return int.from_bytes(self.f.read(2), "little")

    def set(self, cluster, value):
        """Write to every FAT copy - leaving them inconsistent invites a repair."""
        for n in range(self.nfats):
            self.f.seek((self.fat_start + n * self.fatsz) * SECTOR + cluster * 2)
            self.f.write(value.to_bytes(2, "little"))

    def chain(self, cluster):
        seen = set()
        while 2 <= cluster < 0xFFF8 and cluster not in seen:
            seen.add(cluster)
            yield cluster
            cluster = self.get(cluster)

    def free_chain(self, cluster):
        for c in list(self.chain(cluster)):
            self.set(c, 0)

    # --- directories -------------------------------------------------------
    def dir_sectors(self, cluster):
        if cluster == 0:
            return list(range(self.root_start, self.root_start + self.root_sectors))
        return [self.data_start + (c - 2) * self.spc + i
                for c in self.chain(cluster) for i in range(self.spc)]

    def free_tree(self, cluster):
        """Free a directory and everything under it."""
        for sec in self.dir_sectors(cluster):
            self.f.seek(sec * SECTOR)
            data = self.f.read(SECTOR)
            for i in range(0, SECTOR, 32):
                ent = data[i:i + 32]
                if ent[0] == 0x00:
                    break
                if ent[0] == FREE or ent[11] == ATTR_LFN or ent[11] & ATTR_VOLUME:
                    continue
                if bytes(ent[0:8]).strip() in (b".", b".."):
                    continue
                child = u16(ent, 26)
                if ent[11] & ATTR_DIR:
                    self.free_tree(child)
                elif child:
                    self.free_chain(child)
        self.free_chain(cluster)


def lfn_text(entries):
    """Reassemble a long name from its LFN records (they come in reverse)."""
    out = ""
    for ent in reversed(entries):
        chunk = bytes(ent[1:11]) + bytes(ent[14:26]) + bytes(ent[28:32])
        out += chunk.decode("utf-16-le", "replace")
    return out.split("\x00")[0]


def short_text(ent):
    base = bytes(ent[0:8]).decode("ascii", "replace").rstrip()
    ext = bytes(ent[8:11]).decode("ascii", "replace").rstrip()
    return f"{base}.{ext}" if ext else base


def normalize(path):
    stats = {"nt": 0, "lfn": 0, "junk": 0}

    with open(path, "r+b") as f:
        fat = Fat(f)
        todo = [0]
        visited = set()

        while todo:
            cluster = todo.pop()
            if cluster in visited:
                continue
            visited.add(cluster)

            for sec in fat.dir_sectors(cluster):
                f.seek(sec * SECTOR)
                data = bytearray(f.read(SECTOR))
                dirty = False
                pending = []            # LFN records seen since the last short entry

                for i in range(0, SECTOR, 32):
                    ent = data[i:i + 32]
                    if ent[0] == 0x00:
                        break
                    if ent[0] == FREE:
                        continue

                    attr = ent[11]
                    if attr == ATTR_LFN:
                        pending.append((i, bytes(ent)))
                        continue
                    if attr & ATTR_VOLUME:
                        pending = []
                        continue

                    long_name = lfn_text([e for _, e in pending]) if pending else ""
                    short_name = short_text(ent)
                    is_dir = bool(attr & ATTR_DIR)
                    first = u16(ent, 26)
                    dot = bytes(ent[0:8]).strip() in (b".", b"..")

                    if not dot and is_macos_junk(fat, long_name, short_name,
                                                 is_dir, first):
                        # Reclaim the space as well; just hiding the entry would
                        # leak clusters that nothing can ever reach again.
                        if is_dir:
                            fat.free_tree(first)
                        elif first:
                            fat.free_chain(first)
                        data[i] = FREE
                        for j, _ in pending:
                            data[j] = FREE
                        stats["junk"] += 1
                        dirty = True
                        pending = []
                        continue

                    for j, _ in pending:
                        data[j] = FREE
                        stats["lfn"] += 1
                        dirty = True
                    pending = []

                    if ent[12] & NT_LOWERCASE:
                        data[i + 12] = ent[12] & ~NT_LOWERCASE
                        stats["nt"] += 1
                        dirty = True

                    if is_dir and not dot:
                        todo.append(first)

                if dirty:
                    f.seek(sec * SECTOR)
                    f.write(data)

    return stats


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 1
    try:
        st = normalize(argv[1])
    except Exception as e:
        print(f"[-] {e}")
        return 1
    if any(st.values()):
        parts = []
        if st["nt"]:
            parts.append(f"uppercased {st['nt']}")
        if st["lfn"]:
            parts.append(f"removed {st['lfn']} long-name record(s)")
        if st["junk"]:
            parts.append(f"deleted {st['junk']} macOS metadata item(s)")
        print("[*] " + ", ".join(parts))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
