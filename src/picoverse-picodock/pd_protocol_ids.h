// pd_protocol_ids.h — frame constants shared by the firmware and the host.
//
// The wire format is documented in ../pd_protocol.md:
//
//     [0x5A][CMD][LEN_LO][LEN_HI][payload ...][CHK]
//     CHK = CMD ^ LEN_LO ^ LEN_HI ^ payload[*]
//
// Kept in its own header so both the block backend (sunrise_ide.c) and anything
// else that speaks the protocol agree on the numbers without pulling in the
// mailbox or IDE headers.

#ifndef PD_PROTOCOL_IDS_H
#define PD_PROTOCOL_IDS_H

#define PD_SOF                0x5Au

// 0x10/0x11 were the ROM list (host serves a folder, the menu lists it). That
// track was dropped - SofaRun reads ROMs off the virtual disk and does the job
// better - so the pair is free. See archive/README.md.

// Block device (cartridge <-> host, never passes through the MSX) — D4
#define PD_BLK_INFO_REQ       0x20u   // -> host : none
#define PD_BLK_INFO_RESP      0x21u   // <- host : [st:1][block_count:4][block_size:2]
#define PD_BLK_READ_REQ       0x22u   // -> host : [lba:4][count:1]
#define PD_BLK_READ_RESP      0x23u   // <- host : [st:1][data: count*512]
#define PD_BLK_WRITE_REQ      0x24u   // -> host : [lba:4][count:1][data: count*512]
#define PD_BLK_WRITE_RESP     0x25u   // <- host : [st:1]

// Mailbox bytes multiplexed onto the same pipe as the block protocol — B0.
//
// The MSX reaches the mailbox from MSX-DOS, which is exactly when the block
// backend owns the CDC link, so mailbox traffic cannot go out raw: it would
// land inside a block frame. It gets its own command instead, and the block
// backend relays it. Payload is an opaque run of bytes, no framing of its own -
// any protocol the MSX and host agree on is layered on top.
#define PD_CMD_MB_TO_HOST     0x30u   // -> host : [bytes...] from the MSX
#define PD_CMD_MB_TO_MSX      0x31u   // <- host : [bytes...] for the MSX

// Virtual printer (cartridge -> host), multiplexed onto the same pipe — printer
// merge. Payload is a run of captured MSX print bytes; the host reassembles the
// job by idle timeout, as it always did for the standalone printer firmware.
#define PD_CMD_PRINT_DATA     0x40u   // -> host : [bytes...] printed by the MSX

#endif // PD_PROTOCOL_IDS_H
