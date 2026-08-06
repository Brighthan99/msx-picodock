#!/usr/bin/env python3
"""make_disk.py - build a FAT16 disk image that Nextor accepts (D4f).

    ./src/host/make_disk.py picodock.img 128m [VOLNAME]

Why this is not hdiutil / mkfs.vfat
-----------------------------------
Both produce a perfectly valid FAT16 image that **Nextor refuses to mount**. The
layouts were compared field by field against one Nextor's own
FDISK produced:

    field            hdiutil            Nextor FDISK
    MBR type         0x06 (FAT16 CHS)   0x0E (FAT16 LBA)
    MBR CHS          h254 s63 c1023     all zero
    boot flag        0x00               0x80
    media            0xF8               0xF0
    sectors/track    32                 0
    heads            16                 0
    hidden sectors   1                  0

Type 0x06 tells Nextor "FAT16 addressed by CHS", and the CHS fields were the
"LBA only" marker rather than real geometry. Nextor also states it never trusts
the partition type code and examines the partition's first sector instead, so the
BPB had to match too. Writing the image here means every one of those fields is
ours to set - and it removes the macOS/Linux tooling split as a bonus.

Layout produced (mirrors FDISK):

    LBA 0            MBR, one partition, type 0x0E, active, CHS zeroed
    LBA 1            FAT16 boot sector (BPB below)
    +reserved        FAT #1, FAT #2
    +                root directory (512 entries)
    +                data area
"""

import os
import sys

SECTOR = 512
FAT16_MAX_CLUSTERS = 65524      # above this it would be FAT32
ROOT_ENTRIES = 512
RESERVED = 1
NUM_FATS = 2
MEDIA = 0xF0                    # what FDISK writes (0xF8 is the usual PC value)
PART_START = 1                  # FDISK puts the partition right after the MBR
PART_TYPE = 0x0E                # FAT16 LBA - the type Nextor uses


def pick_cluster_sectors(part_sectors):
    """Smallest cluster that keeps the count inside the FAT16 limit.

    Smaller clusters waste less per file, so take the first that fits rather
    than jumping straight to 32KB.
    """
    for spc in (4, 8, 16, 32, 64):          # 2KB .. 32KB
        root_sectors = (ROOT_ENTRIES * 32 + SECTOR - 1) // SECTOR
        # Solve for the FAT size: it depends on the cluster count, which depends
        # on the FAT size. Two passes converge for every practical geometry.
        fat_sectors = 1
        for _ in range(8):
            data = part_sectors - RESERVED - NUM_FATS * fat_sectors - root_sectors
            if data <= 0:
                break
            clusters = data // spc
            need = ((clusters + 2) * 2 + SECTOR - 1) // SECTOR
            if need == fat_sectors:
                break
            fat_sectors = need
        else:
            continue
        data = part_sectors - RESERVED - NUM_FATS * fat_sectors - root_sectors
        clusters = data // spc if data > 0 else 0
        if 0 < clusters <= FAT16_MAX_CLUSTERS:
            return spc, fat_sectors, clusters
    return None, None, None


def build_mbr(part_start, part_sectors):
    mbr = bytearray(SECTOR)
    e = 0x1BE
    mbr[e + 0] = 0x80                        # active
    mbr[e + 1:e + 4] = b"\x00\x00\x00"       # CHS start - FDISK leaves these zero
    mbr[e + 4] = PART_TYPE
    mbr[e + 5:e + 8] = b"\x00\x00\x00"       # CHS end
    mbr[e + 8:e + 12] = part_start.to_bytes(4, "little")
    mbr[e + 12:e + 16] = part_sectors.to_bytes(4, "little")
    mbr[510:512] = b"\x55\xAA"
    return bytes(mbr)


def build_boot(volname, spc, fat_sectors, total_sectors):
    b = bytearray(SECTOR)
    b[0:3] = b"\xEB\xFE\x90"                 # jmp $ - the disk is not bootable code
    b[3:11] = b"MSXPDSER "
    b[11:13] = SECTOR.to_bytes(2, "little")
    b[13] = spc
    b[14:16] = RESERVED.to_bytes(2, "little")
    b[16] = NUM_FATS
    b[17:19] = ROOT_ENTRIES.to_bytes(2, "little")
    b[19:21] = (0).to_bytes(2, "little")     # total16 unused; value lives in total32
    b[21] = MEDIA
    b[22:24] = fat_sectors.to_bytes(2, "little")
    b[24:26] = (0).to_bytes(2, "little")     # sectors/track - FDISK writes 0
    b[26:28] = (0).to_bytes(2, "little")     # heads         - FDISK writes 0
    b[28:32] = (0).to_bytes(4, "little")     # hidden        - FDISK writes 0
    b[32:36] = total_sectors.to_bytes(4, "little")
    b[36] = 0x00                             # drive number
    b[38] = 0x29                             # extended boot signature
    b[39:43] = b"\x00\x00\x00\x00"           # volume id
    b[43:54] = volname[:11].upper().ljust(11).encode("ascii", "replace")
    b[54:62] = b"FAT16   "
    b[510:512] = b"\x55\xAA"
    return bytes(b)


def build_fat(fat_sectors):
    fat = bytearray(fat_sectors * SECTOR)
    fat[0] = MEDIA          # first entry mirrors the media descriptor
    fat[1] = 0xFF
    fat[2] = 0xFF
    fat[3] = 0xFF           # second entry: end-of-chain
    return bytes(fat)


def parse_size(text):
    t = text.strip().lower()
    if t.endswith("g"):
        return int(float(t[:-1]) * 1024)
    if t.endswith("m"):
        return int(t[:-1])
    return int(t)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1

    path = argv[1]
    mb = parse_size(argv[2]) if len(argv) > 2 else 128
    volname = argv[3] if len(argv) > 3 else "MSXDISK"

    if not 8 <= mb <= 2048:
        print("[-] size must be between 8MB and 2048MB (FAT16 limit)")
        return 1

    total_sectors = mb * 1024 * 1024 // SECTOR
    # FDISK leaves a sector unused at each end; mirroring that keeps us inside
    # whatever bounds it was being careful about.
    part_sectors = total_sectors - PART_START - 1
    bpb_sectors = part_sectors - 1

    spc, fat_sectors, clusters = pick_cluster_sectors(bpb_sectors)
    if spc is None:
        print(f"[-] no FAT16 geometry fits {mb}MB")
        return 1

    root_sectors = (ROOT_ENTRIES * 32 + SECTOR - 1) // SECTOR

    with open(path, "wb") as f:
        f.write(build_mbr(PART_START, part_sectors))
        f.write(build_boot(volname, spc, fat_sectors, bpb_sectors))
        for _ in range(NUM_FATS):
            f.write(build_fat(fat_sectors))
        f.write(b"\x00" * (root_sectors * SECTOR))
        # Extend to the full size without writing every byte
        f.truncate(total_sectors * SECTOR)

    print(f"[+] {path}  {mb}MB")
    print(f"    partition   LBA {PART_START}, {part_sectors} sectors, type 0x{PART_TYPE:02X} (FAT16 LBA), active")
    print(f"    cluster     {spc} sectors ({spc * SECTOR // 1024}KB)")
    print(f"    clusters    {clusters}  (FAT16 limit {FAT16_MAX_CLUSTERS})")
    print(f"    FAT         {NUM_FATS} x {fat_sectors} sectors, root {ROOT_ENTRIES} entries")
    print(f"    volume      {volname.upper()}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
