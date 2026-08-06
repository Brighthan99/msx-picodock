# The PDSER frame protocol

A minimal framing layer over the host ↔ MSX byte pipe (the cartridge mailbox at
`0xBFF0`–`0xBFF3`). Everything the host and the cartridge say to each other —
disk sectors, printer bytes, mailbox traffic — travels as these frames over one
USB CDC pipe.

## The frame

```
[0x5A][CMD][LEN_LO][LEN_HI][payload ...][CHK]
```

| Field | Size | Meaning |
|---|---|---|
| `0x5A` | 1 | Start marker (for resynchronisation) |
| `CMD` | 1 | Command |
| `LEN` | 2 | Payload length (little-endian) |
| payload | LEN | |
| `CHK` | 1 | `CMD ^ LEN_LO ^ LEN_HI ^ payload[*]` |

The receiver discards bytes until it sees `0x5A`, so noise or a leftover
heartbeat cannot wedge the link — it resynchronises at the next frame.

All integers are little-endian.

## ROM list commands

| CMD | Direction | Payload | Purpose |
|---|---|---|---|
| `0x10` LIST_REQ | MSX → host | none | Ask for the ROM list |
| `0x11` LIST_RESP | host → MSX | `[count:1][record × count]` | The list |

### record (59 bytes) — identical to the on-flash `ROMRecord`

| Offset | Size | Field |
|---|---|---|
| 0 | 50 | Name (space padded, *not* NUL terminated) |
| 50 | 1 | Mapper code |
| 51 | 4 | Size |
| 55 | 4 | Index — where the flash layout keeps an offset. When the host serves the list this is the **index within the list** |

The layout is reused verbatim so that `menu.c`'s parsing, rendering and UI need
no changes at all.

### Mapper codes

```
1 PLA-16   2 PLA-32   3 KonSCC   4 PLN-48   5 ASC-08   6 ASC-16   7 Konami
8 NEO-8    9 NEO-16  10 SYSTEM  11 SYSTEM  12 ASC16X  13 PLN-64  14 MANBW2
```

## Flow control

There is no separate layer for it. The cartridge's RX ring is 1 KB; when it
fills, core1 stops reading from the CDC FIFO and back-pressure appears
naturally at the USB level. How fast the MSX reads *is* the transfer rate.

## Block device commands — the virtual disk

These let the cartridge's Sunrise IDE emulation use **the host as its storage
device**. Unlike the list commands they never pass through the MSX: this is a
conversation between the cartridge and the host, and the MSX simply sees an IDE
disk.

| CMD | Direction | Payload | Purpose |
|---|---|---|---|
| `0x20` BLK_INFO_REQ | cart → host | none | Capacity |
| `0x21` BLK_INFO_RESP | host → cart | `[st:1][block_count:4][block_size:2]` | |
| `0x22` BLK_READ_REQ | cart → host | `[lba:4][count:1]` | Read sectors |
| `0x23` BLK_READ_RESP | host → cart | `[st:1][data: count×512]` | |
| `0x24` BLK_WRITE_REQ | cart → host | `[lba:4][count:1][data: count×512]` | Write sectors |
| `0x25` BLK_WRITE_RESP | host → cart | `[st:1]` | |

`st` is 0 for success, anything else for failure.

`count` is currently always 1, because the IDE state machine asks one sector at
a time. Batching is a possible optimisation, not a current one.

## Mailbox commands — talking to a program on the MSX

| CMD | Direction | Payload | Meaning |
|---|---|---|---|
| `0x30` MB_TO_HOST | cart → host | `[bytes…]` | What the MSX wrote to `TX_DATA` |
| `0x31` MB_TO_MSX | host → cart | `[bytes…]` | What the MSX will read from `RX_DATA` |

The payload is **just a byte stream** — no framing of its own. Whatever the MSX
program and the host agree on rides on top. Maximum 256 bytes per frame
(`MB_FRAME_MAX`).

Nothing in a disk + printer build uses it. The cartridge still multiplexes it
onto the pipe, and the host still recognises `MB_TO_HOST` so that a frame from
anything on the MSX that writes to the mailbox is discarded rather than
mistaken for a block command. The remote keyboard, which is what filled it, is
not part of this build.

## Printer commands

| CMD | Direction | Payload | Meaning |
|---|---|---|---|
| `0x40` PRINT_DATA | cart → host | `[bytes…]` | Bytes the MSX printed (captured from 0xF5/0xF6) |

The standalone virtual-printer firmware streams print bytes over raw CDC. The
integrated firmware puts them on the same pipe as the disk and the mailbox,
in this frame. The host still separates jobs by an idle timeout.

**No flow control.** The standalone firmware answered the 0xF6 status *read*
with a `/WAIT`-based PIO program, which gave back-pressure. The integrated
firmware cannot: `/WAIT` (GPIO28) is already owned by the memory-read path
(PIO0) and cannot be muxed onto the I/O PIO. So only the half with no mux
conflict is used — the I/O *write* capture, which just samples pins — and the
0xF6 read is not emulated (it reads as 0xFF). `LPRINT` text is safe, because the
Z80 is far slower than the USB drain; a sustained bulk graphics dump can in
principle overrun and drop bytes.

For how the MSX side drives 0xF5/0xF6, see [`msx-tools/`](msx-tools/): BASIC
prints through the machine's own port; `PDFRCPRN.COM` arms the responder on an OCM. On
OCM the BIOS printer path reads the real port 0x90 BUSY line itself, which the
cartridge cannot answer, so transparent printing from DOS is not possible —
see `src/host/printer/PRINTING.md`.

### Channel separation — why multiplexing, not switching

The first design **switched the receive path with a mode flag**, reasoning that
menu mode and Nextor mode are never active at the same time: while the menu is
up the menu ROM owns the cartridge address space, and in Nextor mode the IDE
emulation does.

The mailbox broke that reasoning. It has to work **from MSX-DOS**, which is
exactly when the block backend owns the pipe. With switching, both directions
die: everything received goes to the block parser so `RX_READY` never rises,
and the transmit side spills the TX ring unframed into the middle of a block
frame.

So it is **multiplexed within one frame stream**:

```
CDC in  → block backend parser ─┬→ 0x2x  block responses
                                └→ 0x31  mailbox RX ring → the MSX reads it
CDC out ← block backend ────────┬← 0x2x  block requests
                                └← 0x30  mailbox TX ring (what the MSX wrote)
```

Whoever installs the sink is responsible for **both** directions. The core1 pump
does not drain the TX ring as raw bytes while a sink exists (`pd_usb.c`).
Disk has priority over mailbox: a keystroke arriving a few ms late is
invisible, a late disk read is not.

In menu mode (no sink) raw bytes flow exactly as they did before.

A read response is a 513-byte payload, which exceeds the 1 KB mailbox ring —
but block responses are handled by the parser directly and never go through the
ring, so it does not matter.
