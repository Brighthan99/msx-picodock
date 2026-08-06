#!/usr/bin/env python3
"""fat16.py - read and write a FAT16 image without mounting it.

The point of not mounting is portability. Putting a file on the disk used to
mean `hdiutil attach` on macOS and `sudo mount -o loop` on Linux, which is two
implementations, a password prompt on the machine this is most likely to live
on - a Raspberry Pi - and nothing at all on Windows. Writing the filesystem
directly is one implementation that runs wherever Python does.

It also removes a hazard rather than working around one. A mounted image is a
second writer, which is why disk_put.sh has to ask the server to let go and wait
for it to confirm before touching anything. Nothing here mounts, so nothing has
to be handed back and forth.

Scope is deliberately small: FAT16 with a single partition, as make_disk.py
writes it. Not FAT12, not FAT32, no long filenames on the way in - the MSX sees
8.3 and that is what gets written. Long names that already exist (macOS put them
there) are understood well enough to be identified and removed, which is what
disk_normalize.py needs.

Layout, for the arithmetic below:

    partition start ─┬─ reserved sectors (boot sector is the first)
                     ├─ FAT copies      (nfats × fatsz sectors)
                     ├─ root directory  (root_entries × 32 bytes, fixed size)
                     └─ data area       (clusters, numbered from 2)
"""

import os
import struct
import time

SECTOR = 512

FREE = 0xE5                 # first byte of a deleted entry
END_OF_DIR = 0x00

ATTR_READONLY = 0x01
ATTR_HIDDEN = 0x02
ATTR_SYSTEM = 0x04
ATTR_VOLUME = 0x08
ATTR_DIR = 0x10
ATTR_ARCHIVE = 0x20
ATTR_LFN = 0x0F

EOC = 0xFFFF                # end of a cluster chain
BAD = 0xFFF7

#: Characters FAT permits in a short name. Everything else becomes "_".
_OK = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$%'-_@~`!(){}^#&")


def u16(b, o):
    return int.from_bytes(b[o:o + 2], "little")


def fat_time(epoch=None):
    """(date, time) as FAT16 packs them. Before 1980 is not representable."""
    t = time.localtime(epoch if epoch is not None else time.time())
    year = max(t.tm_year, 1980)
    date = ((year - 1980) << 9) | (t.tm_mon << 5) | t.tm_mday
    tm = (t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2)
    return date, tm


def to_83(name, taken=()):
    """`name` as an 8.3 pair, uniquified against `taken` if it collides.

    `taken` is a set of "BBBBBBBBEEE" strings - the 11 raw bytes as FAT stores
    them - which is what the caller gets from `Fat.names`.

    A name that does not fit gets FAT's own answer, `NAME~1`, and the number
    counts up. That is what the MSX will show, and it is worth knowing before
    writing it into an AUTOEXEC.BAT: which file gets ~1 and which gets ~2
    depends on the order they went on, so the caller is expected to warn.
    """
    base, _, ext = name.rpartition(".")
    if not base:                       # no dot at all
        base, ext = ext, ""
    base = "".join(c if c in _OK else "_" for c in base.upper())
    ext = "".join(c if c in _OK else "_" for c in ext.upper())[:3]
    base = base or "_"

    def packed(b):
        return f"{b:<8}{ext:<3}"

    # A name that fits is used as it is, even when the directory already has it.
    # Putting a file that is already there means replacing it - that is what a
    # copy does everywhere else, and uniquifying instead would turn a second run
    # of the same command into a directory full of A.TXT, A~1.TXT, A~2.TXT.
    #
    # `taken` matters only below, where the name does not fit and FAT's ~N has to
    # pick between *different* files that shorten to the same thing.
    if len(base) <= 8:
        return packed(base)

    for n in range(1, 1000000):
        suffix = f"~{n}"
        stem = base[:8 - len(suffix)] + suffix
        if packed(stem) not in taken:
            return packed(stem)
    raise ValueError("no free short name for %r" % name)


class Fat:
    """A FAT16 volume inside an image file opened in "r+b"."""

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
        total = u16(b, 19) or int.from_bytes(b[32:36], "little")
        if not (self.bps == SECTOR and self.spc and self.fatsz):
            raise ValueError("not a FAT16 image this tool understands")

        self.fat_start = self.part + self.reserved
        self.root_start = self.fat_start + self.nfats * self.fatsz
        self.root_sectors = (self.root_entries * 32 + SECTOR - 1) // SECTOR
        self.data_start = self.root_start + self.root_sectors
        self.clusters = (total - (self.data_start - self.part)) // self.spc
        self.f = f

    # --- FAT ---------------------------------------------------------------
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

    def free_count(self):
        return sum(1 for c in range(2, self.clusters + 2) if self.get(c) == 0)

    def alloc(self, count):
        """`count` free clusters, chained together and marked in use."""
        got = []
        c = 2
        while len(got) < count and c < self.clusters + 2:
            if self.get(c) == 0:
                got.append(c)
            c += 1
        if len(got) < count:
            raise IOError("disk full: needed %d clusters, %d free"
                          % (count, len(got)))
        for a, b in zip(got, got[1:]):
            self.set(a, b)
        self.set(got[-1], EOC)
        return got

    # --- data --------------------------------------------------------------
    def cluster_offset(self, cluster):
        return (self.data_start + (cluster - 2) * self.spc) * SECTOR

    def write_clusters(self, clusters, data):
        size = self.spc * SECTOR
        for i, c in enumerate(clusters):
            chunk = data[i * size:(i + 1) * size]
            self.f.seek(self.cluster_offset(c))
            self.f.write(chunk.ljust(size, b"\x00"))

    def read_clusters(self, cluster, size=None):
        out = b""
        step = self.spc * SECTOR
        for c in self.chain(cluster):
            self.f.seek(self.cluster_offset(c))
            out += self.f.read(step)
            if size is not None and len(out) >= size:
                break
        return out[:size] if size is not None else out

    # --- directories -------------------------------------------------------
    def dir_sectors(self, cluster):
        """Sectors making up a directory. Cluster 0 means the root."""
        if cluster == 0:
            return list(range(self.root_start, self.root_start + self.root_sectors))
        return [self.data_start + (c - 2) * self.spc + i
                for c in self.chain(cluster) for i in range(self.spc)]

    def entries(self, cluster):
        """Yield (sector, offset_in_sector, 32 raw bytes) for every slot in use."""
        for sec in self.dir_sectors(cluster):
            self.f.seek(sec * SECTOR)
            data = self.f.read(SECTOR)
            for i in range(0, SECTOR, 32):
                ent = data[i:i + 32]
                if ent[0] == END_OF_DIR:
                    return
                yield sec, i, ent

    def names(self, cluster):
        """The raw 11-byte names in use, for to_83 to avoid."""
        out = set()
        for _, _, ent in self.entries(cluster):
            if ent[0] == FREE or ent[11] == ATTR_LFN:
                continue
            out.add(ent[0:11].decode("latin-1"))
        return out

    def find(self, cluster, name11):
        """(sector, offset, entry) for `name11`, or None."""
        want = name11.encode("latin-1")
        for sec, off, ent in self.entries(cluster):
            if ent[11] == ATTR_LFN or ent[0] == FREE:
                continue
            if ent[0:11] == want:
                return sec, off, ent
        return None

    def _free_slot(self, cluster):
        """A slot to write into, growing the directory if it is a subdirectory."""
        last_sector = None
        for sec in self.dir_sectors(cluster):
            last_sector = sec
            self.f.seek(sec * SECTOR)
            data = self.f.read(SECTOR)
            for i in range(0, SECTOR, 32):
                if data[i] in (END_OF_DIR, FREE):
                    return sec, i
        if cluster == 0:
            raise IOError("the root directory is full (%d entries)"
                          % self.root_entries)
        # Subdirectories grow a cluster at a time; the new one starts empty, so
        # its first slot is the answer and the rest reads as end-of-directory.
        new = self.alloc(1)[0]
        self.f.seek(self.cluster_offset(new))
        self.f.write(b"\x00" * (self.spc * SECTOR))
        tail = [c for c in self.chain(cluster)][-1]
        self.set(tail, new)
        self.set(new, EOC)
        del last_sector
        return self.data_start + (new - 2) * self.spc, 0

    def put_entry(self, cluster, name11, attr, first, size, epoch=None):
        loc = self.find(cluster, name11)
        sec, off = loc[:2] if loc else self._free_slot(cluster)
        date, tm = fat_time(epoch)
        ent = struct.pack("<11sBBBHHHHHHHI",
                          name11.encode("latin-1"), attr, 0, 0,
                          tm, date,          # creation time/date
                          date,              # last access date
                          0,                 # high cluster word (FAT32 only)
                          tm, date,          # write time/date
                          first, size)
        self.f.seek(sec * SECTOR + off)
        self.f.write(ent)
        return sec, off

    # --- the operations a caller wants -------------------------------------
    def add_file(self, cluster, name11, data, epoch=None):
        """Write `data` as `name11` in the directory at `cluster`, replacing it."""
        old = self.find(cluster, name11)
        if old:
            prev = u16(old[2], 26)
            if prev:
                self.free_chain(prev)
        first = 0
        if data:
            per = self.spc * SECTOR
            need = (len(data) + per - 1) // per
            chain = self.alloc(need)
            self.write_clusters(chain, data)
            first = chain[0]
        self.put_entry(cluster, name11, ATTR_ARCHIVE, first, len(data), epoch)

    def mkdir(self, cluster, name11, epoch=None):
        """Create (or find) a subdirectory, returning its first cluster."""
        found = self.find(cluster, name11)
        if found and found[2][11] & ATTR_DIR:
            return u16(found[2], 26)
        if found:
            raise IOError("%s exists and is not a directory" % name11.strip())

        new = self.alloc(1)[0]
        self.f.seek(self.cluster_offset(new))
        self.f.write(b"\x00" * (self.spc * SECTOR))

        date, tm = fat_time(epoch)
        def dot(nm, first):
            return struct.pack("<11sBBBHHHHHHHI", nm, ATTR_DIR, 0, 0,
                               tm, date, date, 0, tm, date, first, 0)
        self.f.seek(self.cluster_offset(new))
        # ".." points at the parent, and the root is written as 0 even though
        # the root has no cluster number - that is what the spec asks for.
        self.f.write(dot(b".          ", new) + dot(b"..         ", cluster))

        self.put_entry(cluster, name11, ATTR_DIR, new, 0, epoch)
        return new

    def remove(self, cluster, name11):
        """Delete a file or a directory tree. True if something was there."""
        found = self.find(cluster, name11)
        if not found:
            return False
        sec, off, ent = found
        first = u16(ent, 26)
        if ent[11] & ATTR_DIR:
            self._free_tree(first)
        elif first:
            self.free_chain(first)
        self.f.seek(sec * SECTOR + off)
        self.f.write(bytes([FREE]))
        return True

    def _free_tree(self, cluster):
        for _, _, ent in self.entries(cluster):
            if ent[0] == FREE or ent[11] == ATTR_LFN or ent[11] & ATTR_VOLUME:
                continue
            if bytes(ent[0:8]).strip() in (b".", b".."):
                continue
            child = u16(ent, 26)
            if ent[11] & ATTR_DIR:
                self._free_tree(child)
            elif child:
                self.free_chain(child)
        self.free_chain(cluster)

    # Kept under the old name so disk_normalize.py reads the same as it did.
    free_tree = _free_tree


def open_image(path):
    """`Fat` on `path`, opened for update. Caller closes fat.f."""
    f = open(path, "r+b")
    try:
        return Fat(f)
    except Exception:
        f.close()
        raise
