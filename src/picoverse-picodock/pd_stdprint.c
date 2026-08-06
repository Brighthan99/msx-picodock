// pd_stdprint.c — STANDARD MSX printer port (0x90/0x91) capture. See the header.
//
// The machine's real printer ports: 0x91 data, 0x90 strobe. This was once a
// sibling of pd_printer.c, PicoDock's private 0xF5/0xF6 capture; that one is in
// archive/ and this is the only path now.

#include "pico/stdlib.h"
#include "hardware/sync.h"

#include "pd_stdprint.h"

// SPSC ring across the core boundary: core0 (strobe edge) is the sole producer,
// core1 (the frame relay) the sole consumer. Same lock-free discipline as
// pd_usb.c - each index is written by exactly one core.
#define SPR_RING_SIZE 4096u
#define SPR_RING_MASK (SPR_RING_SIZE - 1u)

static volatile uint8_t  spr_ring[SPR_RING_SIZE];
static volatile uint32_t spr_head;      // core0 (producer)
static volatile uint32_t spr_tail;      // core1 (consumer)

static uint8_t  spr_latched;            // last byte written to 0x91
static uint8_t  spr_last_strobe = 1u;   // 0x90 bit0, for edge detection

void __not_in_flash_func(pd_stdprint_io_write)(uint16_t port, uint8_t data)
{
    uint8_t p = (uint8_t)(port & 0xFFu);

    if (p == STDPRN_DATA_PORT)
    {
        spr_latched = data;
        return;
    }

    if (p == STDPRN_STROBE_PORT)
    {
        uint8_t strobe = data & 0x01u;
        // Commit on the falling edge (1->0), exactly as a Centronics /STROBE.
        if (spr_last_strobe == 1u && strobe == 0u)
        {
            uint32_t next = (spr_head + 1u) & SPR_RING_MASK;
            if (next != spr_tail)               // drop if full: no back-pressure
            {
                spr_ring[spr_head] = spr_latched;
                __dmb();
                spr_head = next;
            }
        }
        spr_last_strobe = strobe;
    }
}

#ifdef PD_DIAG_KNOCK
void __not_in_flash_func(pd_stdprint_debug_push)(uint8_t byte)
{
    uint32_t next = (spr_head + 1u) & SPR_RING_MASK;
    if (next != spr_tail)
    {
        spr_ring[spr_head] = byte;
        __dmb();
        spr_head = next;
    }
}
#endif

bool __not_in_flash_func(pd_stdprint_get)(uint8_t *byte)
{
    if (spr_tail == spr_head)
        return false;
    *byte = spr_ring[spr_tail];
    __dmb();
    spr_tail = (spr_tail + 1u) & SPR_RING_MASK;
    return true;
}
