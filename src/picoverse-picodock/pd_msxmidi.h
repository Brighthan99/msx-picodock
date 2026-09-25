// pd_msxmidi.h — MSX-MIDI (i8251) 데이터 포트를 엿듣고 맥으로 넘긴다.
//
// pd_midipac 과 헷갈리기 쉬운데, 정반대의 물건이다.
//
//   pd_midipac  — MSX 는 MIDI 를 모른다. PSG 레지스터를 엿보고 카트리지가
//                 MIDI 를 **만들어** 낸다. 음색은 GM 악기가 된다.
//   pd_msxmidi  — MSX 가 **직접 만든** MIDI 바이트를 그대로 통과시킨다.
//                 MIDRY 같은 플레이어나 MSX-MIDI 를 쓰는 소프트가 원본.
//                 번역이 없으니 작곡자가 의도한 그대로 맥에 닿는다.
//
// 왜 수동으로 되는가 (OCM 기준)
//   MSX-MIDI 는 i8251 USART 를 0xE8(데이터)/0xE9(상태) 에 둔다. 소프트는
//   0xE9 를 읽어 TxRDY 를 확인하고 0xE8 에 바이트를 쓴다. 그 0xE9 를 OCM 이
//   이미 몰고 있다 — 실기에서 IN 0xE9 가 5(TxRDY|TxEMPTY)를 안정적으로 낸다.
//   그래서 카트리지는 8251 을 흉내 낼 필요가 없다. **0xE8 쓰기만 주워서**
//   USB-MIDI 로 흘리면 된다. 버스를 몰지 않으니 0xE9 를 두고 OCM 과 다툴
//   일도 없다 — PicoVerse 문서가 경고한 FPGA 버스 충돌을 통째로 피해 간다.
//
//   0xE9 를 아무도 몰지 않는 기계(예: Sony HB-F1XD)에서는 이것만으로 부족하다.
//   소프트가 TxRDY 를 못 봐서 "I/F not found" 로 멈춘다. 그 절반은 이 파일이
//   아니라 multirom.c 의 상태 응답기(PIO0 SM3)가 한다: 0xE9 읽기에 0x05 를
//   PIO 안에서 바로 내서 /WAIT 도 CPU 도 필요 없다. 답하는 동안 /BUSDIR 를
//   내린다 - 실기는 그래야 슬롯 버퍼를 CPU 쪽으로 돌린다. 꺼진 채로 시작하고,
//   PDMIDI.COM 이 0xE9 에서 0xFF 를 읽은 뒤에만 켠다 (2026-09-25). 여기는
//   여전히 어디서나 안전한 절반이다.
//
// 코어 분담 (pd_stdprint 와 같은 규율):
//   core0 — pd_msxmidi_io_write() 로 링에 담기만. 짧고, 버스를 막지 않는다.
//   core1 — pd_msxmidi_task() 가 링을 비우며 tud_midi_* 를 부른다.
//           모든 tud_* 호출은 core1 에서만 일어난다.

#ifndef PD_MSXMIDI_H
#define PD_MSXMIDI_H

#include <stdbool.h>
#include <stdint.h>

// MSX-MIDI 의 i8251 포트. 데이터만 쓰고 상태는 읽지 않는다 — 위 설명 참조.
#define MSXMIDI_PORT_DATA   0xE8u
#define MSXMIDI_PORT_STAT   0xE9u

// core0 — I/O 쓰기 디스패처에서 부른다. 0xE8 이 아니면 즉시 돌아간다.
void pd_msxmidi_io_write(uint16_t port, uint8_t data);

// core1 — pd_usb_task() 루프에서 매번 부른다. 링이 비어 있으면 바로 돌아간다.
void pd_msxmidi_task(void);

// 진단용. "소리가 안 난다" 일 때 제일 먼저 볼 값이다 —
// bytes_in 이 0 이면 MSX 가 0xE8 에 아예 안 쓰고 있다는 뜻이라,
// 원인이 카트리지가 아니라 MSX 쪽(플레이어 옵션 등)이다.
uint32_t pd_msxmidi_bytes_in(void);
uint32_t pd_msxmidi_bytes_out(void);
uint32_t pd_msxmidi_drops(void);

// 마지막으로 0xE8 쓰기를 본 지 얼마나 됐나 (µs). 한 번도 없었으면 UINT64_MAX.
// pd_midipac 이 "지금 MSX 가 직접 MIDI 를 내보내는 중" 인지 알아야 해서 둔다.
uint64_t pd_msxmidi_idle_us(void);

#endif // PD_MSXMIDI_H
