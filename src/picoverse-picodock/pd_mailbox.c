// pd_mailbox.c — slot-memory mailbox (core0). Rationale lives in the header.

#include "pico/stdlib.h"

#include "pd_mailbox.h"
#include "pd_usb.h"

static volatile bool mb_touched;   // has the MSX ever written to the mailbox?

uint8_t __not_in_flash_func(pd_mb_read)(uint16_t addr)
{
    if (addr == PD_MB_STATUS)
    {
        uint8_t st = 0u;
        if (!pd_rx_is_empty())   st |= PD_ST_RX_READY;
        if (pd_tx_is_full())     st |= PD_ST_TX_FULL;
        if (pd_usb_connected())  st |= PD_ST_USB_CONN;
        return st;
    }

    if (addr == PD_MB_RX_DATA)
    {
        uint8_t b;
        return pd_rx_peek(&b) ? b : 0xFFu;   // pure read — queue does not move
    }

    // A write-only register was read.
    return 0xFFu;
}

bool __not_in_flash_func(pd_mb_write)(uint16_t addr, uint8_t data)
{
    if (addr == PD_MB_TX_DATA)
    {
        mb_touched = true;
        // Dropped if the ring is full — the MSX is expected to check STATUS first.
        pd_tx_put(data);
        return true;
    }

    if (addr == PD_MB_RX_ACK)
    {
        mb_touched = true;
        (void)data;
        pd_rx_advance();
        return true;
    }

    return false;
}

bool pd_mb_in_use(void)
{
    return mb_touched;
}

// -----------------------------------------------------------------------
// DOS-mode window (B0)
// -----------------------------------------------------------------------
// Same registers as above, at an address the cartridge still decodes while it
// is serving the Nextor ROM. See the header for why they had to move.

static const char pd_sig[8] = PD_SIGNATURE;

uint8_t __not_in_flash_func(pd_dos_read)(uint16_t addr)
{
    if (addr <= PD_DOS_SIG_END)
        return (uint8_t)pd_sig[addr - PD_DOS_BASE];
    if (addr == PD_DOS_STATUS)
        return pd_mb_read(PD_MB_STATUS);
    if (addr == PD_DOS_RX_DATA)
        return pd_mb_read(PD_MB_RX_DATA);
    return 0xFFu;                       // write-only register read back
}

bool __not_in_flash_func(pd_dos_write)(uint16_t addr, uint8_t data)
{
    if (addr == PD_DOS_TX_DATA)
        return pd_mb_write(PD_MB_TX_DATA, data);
    if (addr == PD_DOS_RX_ACK)
        return pd_mb_write(PD_MB_RX_ACK, data);
    return false;
}

// -----------------------------------------------------------------------
// Link diagnostic heartbeat
// -----------------------------------------------------------------------
// Lets the whole path — core0 -> ring -> core1 -> CDC -> host — be verified from
// the host alone, which mattered while the MSX side could not yet be rebuilt
// (menu.rom needs Fusion-C). Seeing a line means that path is alive *and* that
// core0 is serving the slot bus, since this is only called from the read loop.

#define DIAG_PERIOD_US 1000000ull

static uint64_t diag_next_us;
static bool     diag_banner_done;
static bool     diag_was_connected;

static void __not_in_flash_func(diag_puts)(const char *s)
{
    while (*s)
        pd_tx_put((uint8_t)*s++);
}

// Small decimal printer for the heartbeat. Using printf here would pull code in
// from flash and contend with core0's own XIP reads, so it is hand-rolled.
static void __not_in_flash_func(diag_putu)(uint32_t v)
{
    char buf[11];
    int i = 0;
    if (v == 0)
    {
        pd_tx_put('0');
        return;
    }
    while (v && i < (int)sizeof(buf))
    {
        buf[i++] = (char)('0' + (v % 10u));
        v /= 10u;
    }
    while (i--)
        pd_tx_put((uint8_t)buf[i]);
}

void __not_in_flash_func(pd_mb_diag_tick)(uint32_t reads_served)
{
    if (mb_touched)
        return;   // real traffic has started; the diagnostic steps aside

    // This runs on every menu read (tens of thousands per second), so only do
    // the real check once every 256 calls rather than reading the timer each time.
    if (reads_served & 0xFFu)
        return;

    bool connected = pd_usb_connected();

    // Re-emit the banner on reconnect.
    if (!connected)
    {
        diag_was_connected = false;
        return;
    }
    if (!diag_was_connected)
    {
        diag_was_connected = true;
        diag_banner_done = false;
    }

    uint64_t now = time_us_64();

    if (!diag_banner_done)
    {
        diag_banner_done = true;
        diag_next_us = now + DIAG_PERIOD_US;
        diag_puts("\r\nPicoDock - link up (menu mode)\r\n"
                  "mailbox 0xBFF0-0xBFF3, heartbeat every 1s until MSX uses it\r\n");
        return;
    }

    if (now < diag_next_us)
        return;
    diag_next_us = now + DIAG_PERIOD_US;

    diag_puts("hb reads=");
    diag_putu(reads_served);
    diag_puts("\r\n");
}
