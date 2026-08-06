// pd_mailbox.h — the MSX-facing window onto the host<->MSX byte pipe (A4).
//
// Why slot memory instead of I/O ports
// -----------------------------------
// The 2026-07-23 hardware test proved that OCM handles both cartridge **slot
// memory reads** (the menu and games boot from them) and **memory write
// snooping** (Konami mapper bank switching works). Whether a cartridge can win
// the data bus on an I/O read (`INP`) is still unverified, and OCM has a track
// record of on-chip devices claiming I/O ports (its internal PPI is exactly why
// keyboard-matrix injection is impossible here). So this uses only the path
// that is already proven.
//
// Registers (top 4 bytes of the cartridge window 0x4000-0xBFFF)
// ------------------------------------------------------------
//   0xBFF0  R   STATUS   bit0 RX_READY / bit1 TX_FULL / bit2 USB_CONNECTED
//   0xBFF1  R   RX_DATA  current byte from the host (**no side effect** — the
//                        queue does not advance)
//   0xBFF2  W   TX_DATA  one byte MSX -> host
//   0xBFF3  W   RX_ACK   value ignored; consume the current RX byte and advance
//
// Reads are kept pure so that a BIOS slot scan or an accidental read (a stray
// LDIR, the Z80's own prefetch) cannot silently swallow data. The queue only
// moves when the MSX explicitly writes the ACK register.
//
// MSX-side usage (from code inside the cartridge ROM, not BASIC):
//   receive:  LD A,(0BFF0h) : AND 1 : JR Z,none
//             LD A,(0BFF1h)          ; take the byte
//             LD (0BFF3h),A          ; ACK — advance to the next
//   send:     LD A,(0BFF0h) : AND 2 : JR NZ,wait   ; spin while TX_FULL
//             LD A,c : LD (0BFF2h),A
//
// Scope (currently)
// -----------------
// **Menu mode only.** While a game runs, those addresses belong to the game ROM
// and intercepting them would corrupt it. Track D (pick a ROM from a host folder)
// only needs to talk in menu mode, so this is sufficient. Track B (remote
// control during a game or DOS) needs a separate design.

#ifndef PD_MAILBOX_H
#define PD_MAILBOX_H

#include <stdbool.h>
#include <stdint.h>

#define PD_MB_BASE     0xBFF0u
#define PD_MB_STATUS   (PD_MB_BASE + 0u)
#define PD_MB_RX_DATA  (PD_MB_BASE + 1u)
#define PD_MB_TX_DATA  (PD_MB_BASE + 2u)
#define PD_MB_RX_ACK   (PD_MB_BASE + 3u)
#define PD_MB_END      (PD_MB_BASE + 3u)

#define PD_ST_RX_READY  0x01u
#define PD_ST_TX_FULL   0x02u
#define PD_ST_USB_CONN  0x04u

// --- DOS-mode window (B0) -----------------------------------------------
// Menu mode serves 0x4000-0xBFFF, but in Nextor mode the cartridge only serves
// 0x4000-0x7FFF (one 16KB ROM segment), so 0xBFF0 is unreachable from MSX-DOS.
// The Nextor SunriseIDE ROM leaves 0x7F00-0x7FCF unused in every segment
// (0x7FD0 onwards is its chgbnk routine), so the same registers live there too.
//
//   0x7F00-0x7F07  "PDSERIAL"  signature, read-only
//   0x7F08         STATUS      (R)
//   0x7F09         RX_DATA     (R)   no side effect
//   0x7F0A         TX_DATA     (W)
//   0x7F0B         RX_ACK      (W)
//
// The signature is what makes this findable: a program on the MSX walks the
// slots with RDSLT until it reads "PDSERIAL", so the cartridge works from
// whichever slot it happens to be in. During DOS, page 1 is RAM, so reaching
// these addresses at all requires an inter-slot access.
#define PD_DOS_BASE      0x7F00u
#define PD_DOS_SIG_END   (PD_DOS_BASE + 7u)
#define PD_DOS_STATUS    (PD_DOS_BASE + 8u)
#define PD_DOS_RX_DATA   (PD_DOS_BASE + 9u)
#define PD_DOS_TX_DATA   (PD_DOS_BASE + 10u)
#define PD_DOS_RX_ACK    (PD_DOS_BASE + 11u)
#define PD_DOS_END       (PD_DOS_BASE + 11u)

#define PD_SIGNATURE     "PDSERIAL"

static inline bool pd_dos_is_addr(uint16_t addr)
{
    return addr >= PD_DOS_BASE && addr <= PD_DOS_END;
}

// Value for an MSX read in the DOS window. No side effects.
uint8_t pd_dos_read(uint16_t addr);

// Handle an MSX write in the DOS window; false if the address is not ours.
bool pd_dos_write(uint16_t addr, uint8_t data);

// Is this address a mailbox register? Checked before ROM serving in the menu
// read loop.
static inline bool pd_mb_is_addr(uint16_t addr)
{
    return addr >= PD_MB_BASE && addr <= PD_MB_END;
}

// Value to hand back on an MSX read. No side effects.
uint8_t pd_mb_read(uint16_t addr);

// Handle an MSX write. Returns false if the address is not a mailbox register
// (the caller then continues with its normal handling).
bool pd_mb_write(uint16_t addr, uint8_t data);

// Has the MSX touched the mailbox at all? Used to retire the diagnostic
// heartbeat once real traffic starts.
bool pd_mb_in_use(void);

// Link diagnostic. Called often from the menu loop; emits one line per second
// so the pipe can be checked from the host **without any MSX-side code**.
// Retires itself as soon as the MSX starts using the mailbox.
void pd_mb_diag_tick(uint32_t reads_served);

#endif // PD_MAILBOX_H
