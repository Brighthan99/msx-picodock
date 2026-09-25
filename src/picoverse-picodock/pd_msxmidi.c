// pd_msxmidi.c — MSX-MIDI 데이터 포트(0xE8) 엿듣기. 설명은 헤더 참조.

#include <string.h>

#include "pico/stdlib.h"
#include "hardware/sync.h"
#include "tusb.h"

#include "pd_msxmidi.h"

// SPSC 링. core0(I/O 쓰기)이 유일한 생산자, core1(USB)이 유일한 소비자.
// pd_stdprint.c 와 같은 무잠금 규율 — 각 인덱스를 한 코어만 쓴다.
//
// 크기: MIDI 는 31250 bps 라 초당 약 3125 바이트다. 1024 면 0.3 초분이고,
// core1 이 그보다 오래 막히는 일은 없다 (USB 태스크는 매 루프 돈다).
#define MM_RING_SIZE 1024u
#define MM_RING_MASK (MM_RING_SIZE - 1u)

static volatile uint8_t  mm_ring[MM_RING_SIZE];
static volatile uint32_t mm_head;       // core0 (생산자)
static volatile uint32_t mm_tail;       // core1 (소비자)

static volatile uint32_t mm_bytes_in;
static volatile uint32_t mm_drops;
static uint32_t          mm_bytes_out;  // core1 만 만진다

static volatile uint64_t mm_last_us;    // 마지막 0xE8 쓰기 시각
static volatile bool     mm_seen;       // 한 번이라도 봤나

void __not_in_flash_func(pd_msxmidi_io_write)(uint16_t port, uint8_t data)
{
    if ((port & 0xFFu) != MSXMIDI_PORT_DATA)
        return;

    mm_bytes_in++;
    mm_last_us = time_us_64();
    mm_seen = true;

    const uint32_t next = (mm_head + 1u) & MM_RING_MASK;
    if (next == mm_tail)
    {
        // 가득 찼다. 생산자는 절대 tail 을 건드리지 않는다 — 버리고 센다.
        // MIDI 는 흘려보내는 스트림이라 역압을 걸 곳이 없다. 0xE9 를 우리가
        // 몰지 않으므로 "잠깐 기다려" 라고 말할 방법도 없다.
        mm_drops++;
        return;
    }
    mm_ring[mm_head] = data;
    __dmb();
    mm_head = next;
}

void pd_msxmidi_task(void)
{
    if (mm_tail == mm_head)
        return;

    if (!tud_midi_mounted())
    {
        // 맥이 MIDI 포트를 안 열었다. 쌓아둬 봐야 낡은 음이 나중에 터질
        // 뿐이니 버린다 — 실시간 연주에 지연된 재생은 쓸모가 없다.
        mm_tail = mm_head;
        return;
    }

    // 링의 연속 구간을 한 번에 넘긴다. tud_midi_stream_write() 가 MIDI 바이트
    // 스트림을 USB-MIDI 이벤트 패킷으로 묶어 준다 — 러닝 스테이터스와 SysEx
    // 포함. 그래서 여기서 메시지 경계를 따질 필요가 없다.
    while (mm_tail != mm_head)
    {
        const uint32_t head = mm_head;           // 한 번만 읽는다
        const uint32_t tail = mm_tail;
        const uint32_t run  = (head > tail) ? (head - tail)
                                            : (MM_RING_SIZE - tail);

        // 링은 volatile 이지만 내용은 core0 이 이미 써 놓고 head 를 올린 뒤라
        // 안전하다. const 캐스트는 tud_ API 에 넘기기 위한 것이다.
        const uint8_t *p = (const uint8_t *)&mm_ring[tail];
        const uint32_t n = tud_midi_stream_write(0u, p, run);
        if (n == 0u)
            break;                               // 엔드포인트가 찼다. 다음 턴에.

        mm_tail = (tail + n) & MM_RING_MASK;
        mm_bytes_out += n;
    }
}

uint32_t pd_msxmidi_bytes_in(void)  { return mm_bytes_in; }
uint32_t pd_msxmidi_bytes_out(void) { return mm_bytes_out; }
uint32_t pd_msxmidi_drops(void)     { return mm_drops; }

uint64_t pd_msxmidi_idle_us(void)
{
    if (!mm_seen)
        return UINT64_MAX;
    const uint64_t now = time_us_64();
    const uint64_t last = mm_last_us;
    return (now > last) ? (now - last) : 0u;
}
