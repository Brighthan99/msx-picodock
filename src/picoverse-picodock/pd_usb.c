// pd_usb.c — USB CDC device (core1) for the integrated PicoVerse PDSER firmware.
//
// Descriptors and the core1 pump are lifted from the virtual-printer firmware
// ((c) 2026 Cristiano Goncalves); the RX direction (host -> MSX)
// is new — the printer only ever streamed one way.

#include <string.h>

#include "pico/stdlib.h"
#include "tusb.h"

#include "pico/unique_id.h"
#include "pd_usb.h"

// -----------------------------------------------------------------------
// Cross-core rings
// -----------------------------------------------------------------------
// Sizes are powers of two so the wrap is a mask. Kept modest: multirom already
// occupies ~210KB of the RP2040's 264KB SRAM.
#define TX_RING_SIZE 4096u
#define RX_RING_SIZE 1024u
#define TX_RING_MASK (TX_RING_SIZE - 1u)
#define RX_RING_MASK (RX_RING_SIZE - 1u)

static uint8_t tx_ring[TX_RING_SIZE];
static volatile uint32_t tx_head; // core0 (producer)
static volatile uint32_t tx_tail; // core1 (consumer)

static uint8_t rx_ring[RX_RING_SIZE];
static volatile uint32_t rx_head; // core1 (producer)
static volatile uint32_t rx_tail; // core0 (consumer)

bool __not_in_flash_func(pd_tx_put)(uint8_t byte)
{
    uint32_t next = (tx_head + 1u) & TX_RING_MASK;
    if (next == tx_tail)
        return false; // full
    tx_ring[tx_head] = byte;
    __dmb();          // publish the payload before the index
    tx_head = next;
    return true;
}

bool __not_in_flash_func(pd_tx_is_full)(void)
{
    return ((tx_head + 1u) & TX_RING_MASK) == tx_tail;
}

bool __not_in_flash_func(pd_tx_get)(uint8_t *byte)
{
    if (tx_tail == tx_head)
        return false; // empty
    *byte = tx_ring[tx_tail];
    __dmb();
    tx_tail = (tx_tail + 1u) & TX_RING_MASK;
    return true;
}

bool __not_in_flash_func(pd_rx_put)(uint8_t byte)
{
    uint32_t next = (rx_head + 1u) & RX_RING_MASK;
    if (next == rx_tail)
        return false; // full — the MSX is not draining
    rx_ring[rx_head] = byte;
    __dmb();
    rx_head = next;
    return true;
}

bool __not_in_flash_func(pd_rx_get)(uint8_t *byte)
{
    if (rx_tail == rx_head)
        return false; // empty
    *byte = rx_ring[rx_tail];
    __dmb();
    rx_tail = (rx_tail + 1u) & RX_RING_MASK;
    return true;
}

bool __not_in_flash_func(pd_rx_is_empty)(void)
{
    return rx_tail == rx_head;
}

bool __not_in_flash_func(pd_rx_peek)(uint8_t *byte)
{
    if (rx_tail == rx_head)
        return false;
    *byte = rx_ring[rx_tail];
    return true;
}

void __not_in_flash_func(pd_rx_advance)(void)
{
    if (rx_tail != rx_head)
        rx_tail = (rx_tail + 1u) & RX_RING_MASK;
}

static volatile bool usb_connected;

bool pd_usb_connected(void)
{
    return usb_connected;
}

static pd_rx_sink_t rx_sink;          // NULL -> bytes go to the RX ring
static void (*poll_hook)(void);

void pd_usb_set_rx_sink(pd_rx_sink_t sink)
{
    rx_sink = sink;
}

void pd_usb_set_poll_hook(void (*hook)(void))
{
    poll_hook = hook;
}

uint32_t __not_in_flash_func(pd_usb_write)(const uint8_t *buf, uint32_t len)
{
    if (!tud_cdc_connected())
        return 0;
    uint32_t room = tud_cdc_write_available();
    if (room < len)
        len = room;
    if (len)
        len = tud_cdc_write(buf, len);
    return len;
}

// -----------------------------------------------------------------------
// TinyUSB device descriptors
// -----------------------------------------------------------------------
tusb_desc_device_t const desc_device = {
    .bLength            = sizeof(tusb_desc_device_t),
    .bDescriptorType    = TUSB_DESC_DEVICE,
    .bcdUSB             = 0x0200,
    .bDeviceClass       = TUSB_CLASS_CDC,
    .bDeviceSubClass    = 0,
    .bDeviceProtocol    = 0,
    .bMaxPacketSize0    = CFG_TUD_ENDPOINT0_SIZE,
    .idVendor           = 0x2E8A, // Raspberry Pi
    .idProduct          = 0x000A, // CDC Virtual COM
    .bcdDevice          = 0x0100,
    .iManufacturer      = 0x01,
    .iProduct           = 0x02,
    .iSerialNumber      = 0x03,
    .bNumConfigurations = 0x01
};

uint8_t const *tud_descriptor_device_cb(void)
{
    return (uint8_t const *)&desc_device;
}

enum {
    ITF_NUM_CDC = 0,
    ITF_NUM_CDC_DATA,
    ITF_NUM_TOTAL
};

#define CONFIG_TOTAL_LEN  (TUD_CONFIG_DESC_LEN + TUD_CDC_DESC_LEN)
#define EPNUM_CDC_NOTIF   0x81
#define EPNUM_CDC_OUT     0x02
#define EPNUM_CDC_IN      0x82

uint8_t const desc_configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, CONFIG_TOTAL_LEN,
                          TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_CDC_DESCRIPTOR(ITF_NUM_CDC, 4, EPNUM_CDC_NOTIF, 8,
                       EPNUM_CDC_OUT, EPNUM_CDC_IN, 64)
};

uint8_t const *tud_descriptor_configuration_cb(uint8_t index)
{
    (void)index;
    return desc_configuration;
}

// PID stays 0x000A so the existing host tooling (pd_port.py matches
// VID 2E8A / PID 000A) keeps finding the cartridge. Only the product string
// changes, to tell the two firmwares apart in `system_profiler`.
char const *string_desc_arr[] = {
    (const char[]){ 0x09, 0x04 }, // 0: English
    "PicoDock",                   // 1: Manufacturer
    "PicoDock",             // 2: Product
    NULL,                         // 3: Serial - filled in at run time, see below
    "PicoVerse CDC",              // 4: CDC Interface
};

// The serial number is what lets the host tell two cartridges apart. It used to
// be the literal "123456" on every board, which meant a machine with two
// PicoDocks plugged in saw two devices with identical VID, PID and serial: the
// host tooling could only ever match the first one, and which of the two that
// was came down to enumeration order.
//
// The RP2040 has a unique 64-bit ID in its flash chip, so there is a per-board
// number available for free. Rendered as 16 hex characters it becomes a stable
// name for this cartridge - stable across replug, reset and reflash, which a
// device path (/dev/cu.usbmodem1234561) is not.
static char serial_str[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1];

static const char *usb_serial(void)
{
    if (serial_str[0] == '\0')
        pico_get_unique_board_id_string(serial_str, sizeof(serial_str));
    return serial_str;
}

static uint16_t _desc_str[32];

uint16_t const *tud_descriptor_string_cb(uint8_t index, uint16_t langid)
{
    (void)langid;
    uint8_t chr_count;

    if (index == 0) {
        memcpy(&_desc_str[1], string_desc_arr[0], 2);
        chr_count = 1;
    } else {
        if (!(index < sizeof(string_desc_arr) / sizeof(string_desc_arr[0])))
            return NULL;
        const char *str = (index == 3) ? usb_serial() : string_desc_arr[index];
        chr_count = strlen(str);
        if (chr_count > 31)
            chr_count = 31;
        for (uint8_t i = 0; i < chr_count; i++)
            _desc_str[1 + i] = str[i];
    }
    _desc_str[0] = (TUSB_DESC_STRING << 8) | (2 * chr_count + 2);
    return _desc_str;
}

// -----------------------------------------------------------------------
// Core 1 — TinyUSB device pump
// -----------------------------------------------------------------------
void __not_in_flash_func(pd_usb_task)(void)
{
    tusb_init();

    while (true) {
        tud_task();

        bool connected = tud_cdc_connected();
        usb_connected = connected;

        if (poll_hook)
            poll_hook();

        if (connected) {
            // MSX -> host, raw.
            //
            // Only when nobody owns the receive path. With a sink installed the
            // pipe carries *framed* traffic, and the sink owner drains this ring
            // itself (pd_tx_get) to wrap the bytes in a frame. Draining it raw
            // here would drop them into the middle of someone else's frame -
            // which is exactly what made the B0 echo test fail.
            if (!rx_sink) {
                while (tx_tail != tx_head && tud_cdc_write_available() > 0) {
                    tud_cdc_write_char(tx_ring[tx_tail]);
                    __dmb();
                    tx_tail = (tx_tail + 1u) & TX_RING_MASK;
                }
            }
            tud_cdc_write_flush();      // also flushes the sink owner's writes

            // host -> MSX (or to whoever owns the receive path)
            if (rx_sink) {
                while (tud_cdc_available())
                    rx_sink((uint8_t)tud_cdc_read_char());
            } else {
                while (tud_cdc_available()) {
                    uint32_t next = (rx_head + 1u) & RX_RING_MASK;
                    if (next == rx_tail)
                        break; // ring full — leave the byte in the CDC FIFO
                    rx_ring[rx_head] = (uint8_t)tud_cdc_read_char();
                    __dmb();
                    rx_head = next;
                }
            }
        } else {
            // No host: keep the TX ring drained so core0 never sees "full"
            // and stalls the MSX. core1 owns tx_tail, so this is race-free —
            // never write tx_head here.
            tx_tail = tx_head;
        }
    }
}
