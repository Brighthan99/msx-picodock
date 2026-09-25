// pd_usb.c — USB CDC device (core1) for the integrated PicoVerse PDSER firmware.
//
// Descriptors and the core1 pump are lifted from the virtual-printer firmware
// ((c) 2026 Cristiano Goncalves); the RX direction (host -> MSX)
// is new — the printer only ever streamed one way.

#include <string.h>

#include "pico/stdlib.h"
#include "tusb.h"

#include "pico/unique_id.h"
#include "pico/bootrom.h"
#include "pd_usb.h"
#include "pd_midipac.h"
#include "pd_msxmidi.h"

// -----------------------------------------------------------------------
// 1200 bps 터치 — 버튼 없이 BOOTSEL 로
// -----------------------------------------------------------------------
// 카트리지를 구우려면 슬롯에서 빼서 BOOTSEL 을 누른 채 다시 꽂아야 한다. 굽는
// 것보다 그 준비가 번거롭다. 호스트가 이 CDC 포트를 **1200 bps 로 열면**
// 펌웨어가 스스로 부트로더로 넘어간다.
//
// **반드시 line_coding 이어야 한다.** 처음에 line_state(DTR)로 썼다가 두 번
// 실패했다. 포트를 여는 순서가 이렇기 때문이다:
//
//     1. open()       DTR ↑   보율은 아직 기본값 - 1200 이 아니다
//     2. tcsetattr()  보율이 1200 이 된다. line_state 콜백은 오지 않는다
//     3. dtr = False  DTR ↓   맥에서 이것이 오는지조차 확실하지 않다
//
// Pico SDK 의 공식 구현도 line_coding 을 쓰고 DTR 은 전혀 보지 않는다 —
// pico_stdio_usb/reset_interface.c 의 tud_cdc_line_coding_cb 참조. 그쪽은
// PICO_STDIO_USB_ENABLE_RESET_VIA_BAUD_RATE 로 기본 켜짐이지만, 그 모듈은
// "TinyUSB 를 직접 쓰지 않는" 프로그램용이라 우리에게는 안 딸려 온다.
//
// SDK 와 같이 **제어 전송 안에서 바로** 재부팅한다. 미룰 이유가 없다는 것을
// 공식 구현이 보여 준다.
//
// 인자 0,0 = USB 활동 표시 LED 없음, 인터페이스 둘 다(MSC+PICOBOOT) 활성.
void tud_cdc_line_coding_cb(uint8_t itf, cdc_line_coding_t const *lc)
{
    (void)itf;
    if (lc->bit_rate == 1200u)
        rom_reset_usb_boot(0u, 0u);      // 돌아오지 않는다
}

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

static bool (*pipe_busy_hook)(void);

void pd_usb_set_pipe_busy_hook(bool (*hook)(void))
{
    pipe_busy_hook = hook;
}

bool __not_in_flash_func(pd_usb_pipe_busy)(void)
{
    return pipe_busy_hook ? pipe_busy_hook() : false;
}

// 통째로 들어갈 자리가 있는가. 프레임을 보내는 쪽은 이걸 먼저 물어야 한다 -
// pd_usb_write 는 자리가 모자라면 **잘라서** 쓰기 때문이다. 20 바이트 프레임이
// 12 바이트만 나가면 받는 쪽은 다음 SOF 까지 통째로 버린다.
uint32_t __not_in_flash_func(pd_usb_write_room)(void)
{
    if (!tud_cdc_connected())
        return 0;
    return tud_cdc_write_available();
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
    // CDC 하나였을 때는 TUSB_CLASS_CDC 로 충분했다. MIDI 가 붙어 복합 장치가
    // 되면서 인터페이스 연결 디스크립터(IAD)가 필요해졌고, 그것을 쓰려면
    // 장치 클래스가 MISC/COMMON/IAD 여야 한다. VID·PID 는 그대로라
    // pd_port.py 의 매칭은 영향을 받지 않는다.
    .bDeviceClass       = TUSB_CLASS_MISC,
    .bDeviceSubClass    = MISC_SUBCLASS_COMMON,
    .bDeviceProtocol    = MISC_PROTOCOL_IAD,
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

// MIDI 는 인터페이스를 둘 쓴다 (오디오 컨트롤 + MIDI 스트리밍).
enum {
    ITF_NUM_CDC = 0,
    ITF_NUM_CDC_DATA,
    ITF_NUM_MIDI,
    ITF_NUM_MIDI_STREAMING,
    ITF_NUM_TOTAL
};

#define CONFIG_TOTAL_LEN  (TUD_CONFIG_DESC_LEN + TUD_CDC_DESC_LEN + TUD_MIDI_DESC_LEN)
#define EPNUM_CDC_NOTIF   0x81
#define EPNUM_CDC_OUT     0x02
#define EPNUM_CDC_IN      0x82
#define EPNUM_MIDI_OUT    0x03
#define EPNUM_MIDI_IN     0x83

// 맥은 이 하나를 시리얼 포트 하나와 MIDI 포트 하나로 동시에 본다.
// 디스크 서버(pd_diskserver.py)와 신디사이저가 서로를 몰라도 같이 돈다.
uint8_t const desc_configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, ITF_NUM_TOTAL, 0, CONFIG_TOTAL_LEN,
                          TUSB_DESC_CONFIG_ATT_REMOTE_WAKEUP, 100),
    TUD_CDC_DESCRIPTOR(ITF_NUM_CDC, 4, EPNUM_CDC_NOTIF, 8,
                       EPNUM_CDC_OUT, EPNUM_CDC_IN, 64),
    TUD_MIDI_DESCRIPTOR(ITF_NUM_MIDI, 5, EPNUM_MIDI_OUT, EPNUM_MIDI_IN, 64)
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
    "PicoDock MIDI",              // 5: MIDI Interface (MIDI-PAC)
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

        // PSG -> MIDI. 20 ms 가 안 지났으면 즉시 돌아간다.
        // tud_* 를 부르므로 반드시 core1 인 이 루프 안에서만 돈다.
        pd_midipac_task();
        pd_msxmidi_task();

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
