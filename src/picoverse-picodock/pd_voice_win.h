// pd_voice_win.h — the window the MSX reads speech out of.
//
// The MSX has no DAC. It has a PSG whose **volume register becomes the output
// level** once the tone period is zero, and three of those channels summed give
// 808 distinct levels. So the host synthesises speech, turns it into one byte a
// sample indexing a 768-byte volume table, and the Z80's whole job is to read a
// byte and write three registers. See `src/host/pd_voice.py`.
//
// What this file is: the ring those bytes sit in on the way through, and the
// three addresses the MSX sees.
//
// The window (Nextor mode, just past the mailbox at 0x7F00-0x7F0B)
// ---------------------------------------------------------------
//   0x7F0C  R   DATA    the next sample. **Reading advances.**
//   0x7F0D  R   STATUS  bit0 READY / bit1 ENDED / bit2 UNDERRUN
//   0x7F0E  W   CTRL    1 = start, 0 = stop and throw away what is queued
//
// **Reading advances, and that is the opposite of the mailbox.** `pd_mailbox.h`
// keeps its reads pure on purpose: a BIOS slot scan or a stray `LDIR` must not
// silently swallow a byte of a message. That reasoning still holds - which is
// why this is a *different address*, not a mode on the same one. Nothing reads
// 0x7F0C by accident: during DOS page 1 is RAM, so reaching it at all takes a
// deliberate inter-slot access, and the ROM header scan reads 0x4000, not here.
// A dropped sample is also a click, not a lost message.
//
// Why a ring at all
// -----------------
// 11025 samples a second is 10.8 KB/s, and USB CDC does not deliver at a steady
// rate - it bursts and stalls. The ring is the cushion. 4 KB is 0.37 seconds,
// which is far more than any stall seen on this link, and it costs 4 KB of the
// RP2040's 264.
//
// One producer, one consumer, no lock
// -----------------------------------
// The host side feeds from core 0 (USB); the MSX side drains from wherever the
// bus handler runs. `head` is written only by the producer and `tail` only by
// the consumer, both free-running and masked on use, so there is no full/empty
// ambiguity and no moment where both must agree. That is the whole reason the
// counters are not reset to zero on wrap.
//
// No Pico SDK here
// ----------------
// So it can be built and tested on a PC, which is the only way to know the ring
// is right before burning a cartridge. `tests/test_pd_voice_win.c` does that.
// msx-picopsg's `tts_cart.h` is written the same way for the same reason.

#ifndef PD_VOICE_WIN_H
#define PD_VOICE_WIN_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

//: 버스 핸들러에서 도는 함수를 RAM 에 두기 위한 고리. 카트리지 빌드가
//: `PD_VOICE_ON_CART` 를 켜면 SDK 의 매크로가 되고, PC 에서는 아무것도 아니다
//: - 그 "아무것도 아님" 이 이 파일을 SDK 없이 짓게 해 준다.
#ifdef PD_VOICE_ON_CART
#include "pico.h"
#define PD_VOICE_FUNC(f) __not_in_flash_func(f)
#else
#define PD_VOICE_FUNC(f) f
#endif

// --- the window ------------------------------------------------------------
#define PD_VOICE_BASE     0x7F0Cu
#define PD_VOICE_DATA     (PD_VOICE_BASE + 0u)
#define PD_VOICE_STATUS   (PD_VOICE_BASE + 1u)
#define PD_VOICE_CTRL     (PD_VOICE_BASE + 2u)
#define PD_VOICE_END      (PD_VOICE_BASE + 2u)

#define PD_VOICE_READY     0x01u   // a sample is waiting
#define PD_VOICE_ENDED     0x02u   // the host said that was all, and it is gone
#define PD_VOICE_UNDERRUN  0x04u   // the MSX read faster than the host fed

//: 4096 bytes is 0.37s at 11025 Hz. Must be a power of two - the masking
//: below depends on it.
#define PD_VOICE_RING     4096u

typedef struct {
    uint8_t  buf[PD_VOICE_RING];
    volatile uint32_t head;     // producer only (host bytes in)
    volatile uint32_t tail;     // consumer only (MSX reads out)
    volatile uint8_t  armed;    // the MSX wrote 1 to CTRL
    volatile uint8_t  closed;   // the host said no more is coming
    volatile uint8_t  hold;     // last sample handed out
    volatile uint8_t  starved;  // an underrun happened since the last start
    //: The MSX wrote 0 to CTRL - it has stopped, whether or not the host had
    //: said the word was over. **The host cannot see this any other way.**
    //: Stopping clears `closed`, so without this the status says "not ended"
    //: for ever and the host waits to speak again until something resets it.
    volatile uint8_t  stopped;
    volatile uint32_t fed;      // bytes accepted, for the log
    volatile uint32_t played;   // bytes handed to the MSX, for the log
} pd_voice_t;

//: The level a silent PSG sits at. **Not zero.** This is a DAC: zero is the
//: bottom of the swing, and the middle is silence. Starting or ending at zero
//: is a step of half the range, which is a click.
#define PD_VOICE_SILENCE  128u

// Throw everything away and go back to not armed.
void pd_voice_reset(pd_voice_t *v);

// --- host side (core 0) ----------------------------------------------------

// How many bytes would be accepted right now.
uint32_t pd_voice_room(const pd_voice_t *v);

// Queue up to `n` bytes. Returns how many were taken - **short writes are
// normal**, the caller keeps the rest and comes back.
uint32_t pd_voice_feed(pd_voice_t *v, const uint8_t *data, uint32_t n);

// No more is coming. What is already queued still plays.
void pd_voice_close(pd_voice_t *v);

//: The status frame the host's flow control runs on. **Written here, not in
//: sunrise_ide.c**, because the host has a second implementation of this same
//: layout (`node/src/voicestream.js`) and two implementations of one format
//: drift - that is exactly how the white stripes got into the ESC/P renderer.
//: Here it is free of the SDK, so a PC test can build the real bytes and hand
//: them to the real parser.
#define PD_VOICE_STAT_FRAME  12u

// Fills `out` (PD_VOICE_STAT_FRAME bytes) and returns how many were written.
uint32_t pd_voice_status_frame(const pd_voice_t *v, uint8_t *out);

// --- MSX side (bus handler) ------------------------------------------------

// Is this one of ours? Checked before the ROM read, like the mailbox.
static inline bool pd_voice_is_addr(uint16_t addr)
{
    return addr >= PD_VOICE_BASE && addr <= PD_VOICE_END;
}

// An MSX read. **DATA advances; STATUS does not.**
uint8_t PD_VOICE_FUNC(pd_voice_read)(pd_voice_t *v, uint16_t addr);

// An MSX write. False if the address is not ours.
bool PD_VOICE_FUNC(pd_voice_write)(pd_voice_t *v, uint16_t addr, uint8_t data);

#endif // PD_VOICE_WIN_H
