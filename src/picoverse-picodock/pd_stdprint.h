// pd_stdprint.h — STANDARD MSX printer port capture (ports 0x90 / 0x91).
//
// This is the WRITE half of standard-printer-port support; the READ half (the
// BUSY status answered on IN 0x90) lives in msx_bus.pio (msx_status_read_responder).
// Together they let software that drives the Centronics port directly — the
// file-hunter word processors, LPRINT without the H.LPTO hook, etc. — print
// through PicoDock, on the machine's real printer ports rather than PicoDock's
// private 0xF5/0xF6 pair.
//
// This began as a sibling of pd_printer.c, PicoDock's own 0xF5/0xF6 capture,
// with its own data latch, strobe edge detector and SPSC ring so the two could
// not interfere. That private pair is in archive/ now and this is the only
// capture path: the MSX prints through its own printer port, so LPRINT and
// COPY ... PRN work with no MSX-side tool. Bytes are relayed to the host as
// PD_CMD_PRINT_DATA frames, unchanged.
//
// Standard MSX printer port:
//   0x91 W   data latch (8-bit byte to print)
//   0x90 W   bit0 = /STROBE — a 1->0 edge commits the latched byte (Centronics)
//   0x90 R   status (BUSY bit1) — answered by the PIO responder, not here
//
// Gated by PD_STDPRINT_WRITE (independent of the read responder's
// PD_P90_READ). This write-capture half is a pure bus snoop and is safe on
// any machine — a real MSX with a physical printer port can enable it alone
// (with a dummy plug) while leaving the OCM-only read responder off. Off by
// default, so the shipping firmware is unchanged.

#ifndef PD_STDPRINT_H
#define PD_STDPRINT_H

#include <stdbool.h>
#include <stdint.h>

#define STDPRN_STROBE_PORT 0x90u   // W: bit0 = /STROBE
#define STDPRN_DATA_PORT   0x91u   // W: data latch

// core0: feed one captured I/O write. Ports other than 0x90/0x91 are ignored,
// so the caller can hand it every I/O write without pre-filtering.
void pd_stdprint_io_write(uint16_t port, uint8_t data);

// core1: take the next committed byte for framing. False if none waiting.
bool pd_stdprint_get(uint8_t *byte);

#ifdef PD_DIAG_KNOCK
//: Diagnostic only. Pushes one byte straight into the printer ring so it comes
//: out on the host's print capture - a way to see firmware-internal events with
//: no protocol change. Built only with -DPD_DIAG_KNOCK=ON; never in a shipping UF2.
void pd_stdprint_debug_push(uint8_t byte);
#endif

#endif // PD_STDPRINT_H
