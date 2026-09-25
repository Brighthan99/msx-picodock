// pd_usb.h — USB CDC device side of the integrated PicoVerse PDSER firmware.
//
// Derived from the virtual-printer firmware's CDC code
// (prev-dev/software/loadrom.pio/pico/printer/printer_main.c,
//  (c) 2026 Cristiano Goncalves), split out so that core0 keeps
// running multirom's slot-bus + mapper logic untouched.
//
// Roles:
//   core0 — multirom: slot bus, ROM serving, mapper emulation
//   core1 — this module: TinyUSB device, CDC to the host
//
// Two single-producer/single-consumer rings cross the core boundary. Each index
// is written by exactly one core, so no locking is needed:
//
//   TX  MSX -> host : core0 calls pd_tx_put()   / core1 drains
//   RX  host -> MSX : core1 fills                 / core0 calls pd_rx_get()
//
// TinyUSB is NOT multi-core safe: every tud_* call lives on core1. core0 must
// only ever touch the rings.

#ifndef PD_USB_H
#define PD_USB_H

#include <stdbool.h>
#include <stdint.h>

// Core1 entry point. Never returns.
void pd_usb_task(void);

// --- TX: MSX -> host (called from core0) ---------------------------------
// Returns false if the ring is full (byte dropped — caller decides policy).
bool pd_tx_put(uint8_t byte);
bool pd_tx_is_full(void);

// Take a byte back off the TX ring. **core1 only** - it is the consumer. Used
// by whoever owns the receive path to wrap MSX bytes in frames instead of
// letting the pump emit them raw (see pd_usb_set_rx_sink below).
bool pd_tx_get(uint8_t *byte);

// --- RX: host -> MSX (called from core0) ---------------------------------
// Returns false if no byte is waiting.
bool pd_rx_get(uint8_t *byte);
bool pd_rx_is_empty(void);

// Peek/advance split, for the slot mailbox: an MSX *read* of the data register
// must have no side effect (the BIOS slot scan, a stray LDIR or the Z80's own
// prefetch can read an address without meaning to), so the queue only moves
// when the MSX explicitly writes the ACK register.
bool pd_rx_peek(uint8_t *byte);
void pd_rx_advance(void);

// Push a byte into the RX ring. **core1 only** - it is the producer. A sink
// owner calls this to hand the MSX the payload it unpacked from a frame.
// Returns false if the ring is full (the MSX is not draining it).
bool pd_rx_put(uint8_t byte);

// True once the host has opened the CDC port. Safe to read from core0.
bool pd_usb_connected(void);

// --- Receive routing (core1) ---------------------------------------------
// With a sink installed every received byte goes to it; with NULL (the default)
// bytes go straight to the RX ring for the MSX to read through the mailbox.
//
// poll_hook, if set, is called once per pump iteration - that is where a sink
// owner drives its own state machine and transmits.
//
// Installing a sink means "this pipe now carries framed traffic", and it makes
// the owner responsible for **both** directions: the pump stops draining the TX
// ring raw, so the owner must call pd_tx_get() and wrap those bytes, and must
// call pd_rx_put() for payload destined for the MSX.
//
// It did not use to work that way. The original assumption was that menu mode
// and Nextor mode never run at the same time, so the receive path could simply
// be switched rather than multiplexed. B0 broke it: the mailbox has to work
// during MSX-DOS, which is precisely when the block backend owns the pipe.
typedef void (*pd_rx_sink_t)(uint8_t byte);
void pd_usb_set_rx_sink(pd_rx_sink_t sink);
void pd_usb_set_poll_hook(void (*hook)(void));

// 파이프에 **프레임이 반쯤 나가 있는가.** 블록 백엔드는 한 프레임을 여러 번에
// 나눠 쓰므로(blk_tx_pump), 그 사이에 남이 끼어들면 프레임이 찢어진다. 끼어들
// 수 있는 쪽(PSG 스트림)이 이걸 물어보고 비켜선다.
//
// 훅이 없으면 항상 false 다 - 단일 생산자 모드에서는 물어볼 것이 없다.
void pd_usb_set_pipe_busy_hook(bool (*hook)(void));
bool pd_usb_pipe_busy(void);

// Write bytes to the host. **core1 only** (TinyUSB is not multi-core safe).
// Returns how many bytes were accepted; the caller retries the rest later.
uint32_t pd_usb_write(const uint8_t *buf, uint32_t len);

// 지금 몇 바이트가 통째로 들어가는가. 프레임은 잘리면 못 쓰므로
// 보내기 전에 이걸로 확인한다.
uint32_t pd_usb_write_room(void);

#endif // PD_USB_H
