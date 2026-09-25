// pd_midipac.h — PSG(AY-3-8910/YM2149) 를 엿듣고 MIDI 로 옮겨 적는다.
//
// MSX PicoVerse 의 MIDI-PAC 펌웨어와 같은 일을 하되, 나가는 곳이 다르다.
// 원본은 카트리지의 USB **호스트** 포트에 꽂힌 MIDI 음원으로 보내지만,
// PicoDock 은 USB **디바이스**라 맥으로 보낸다 (CDC + MIDI 복합 장치).
//
// 완전히 수동이다. 이 파일의 어떤 코드도 MSX 버스를 구동하지 않는다.
// 입력은 이미 돌고 있는 I/O 쓰기 캡터가 넘겨주는 것을 받기만 한다.
//
// 코어 분담 (PicoDock 의 기존 규율 그대로):
//   core0 — pd_midipac_io_write() 로 PSG 그림자만 갱신. 짧고, 버스를 막지 않는다.
//   core1 — pd_midipac_task() 가 50 Hz 로 스냅샷을 떠서 MIDI 를 만들어 보낸다.
//           모든 tud_* 호출은 core1 에서만 일어난다.
//
// 설계는 MSX PicoVerse MIDI-PAC ((c) 2026 Cristiano Goncalves, CC BY-NC-SA 4.0)
// 에서 왔다. 이 저장소도 같은 라이선스다 — NOTICE.md 참조.

#ifndef PD_MIDIPAC_H
#define PD_MIDIPAC_H

#include <stdbool.h>
#include <stdint.h>

// MSX 의 PSG I/O 포트.
#define PSG_PORT_ADDR 0xA0u // 레지스터 번호 쓰기
#define PSG_PORT_DATA 0xA1u // 레지스터 값 쓰기

// core1 에서 한 번. tud_midi 가 아직 안 올라와 있어도 된다.
void pd_midipac_init(void);

// core0 — I/O 쓰기 디스패처에서 부른다. 0xA0/0xA1 이 아니면 즉시 돌아간다.
void pd_midipac_io_write(uint16_t port, uint8_t data);

// core1 — pd_usb_task() 루프에서 매번 부른다. 20 ms 가 안 지났으면 바로 돌아간다.
void pd_midipac_task(void);

// 톤 채널이 쓸 GM 악기 (0..127). 기본값은 80 (Lead 1 square).
// 같은 번호라도 사운드폰트마다 소리가 달라서, 고르는 것은 듣는 사람 몫이다.
void pd_midipac_set_program(uint8_t prog);

// 스위치 셋. 그림자(PSG 사본)는 어느 경우에도 계속 갱신된다 - 끄는 것은
// **내보내기**뿐이다. 그래야 다시 켰을 때 최신 상태에서 이어진다.
//
//   enabled      둘 다. 예전부터 있던 마스터 스위치
//   stream       PSG 원음 프레임(0x50) 을 CDC 로 보낼 것인가
//   midi         PSG -> MIDI 변환을 USB-MIDI 로 보낼 것인가
//
// **셋 다 기본값은 켜짐이다.** 호스트가 PD_CMD_CTRL 로 끈다 - 그 명령은
// Sunrise 모드에서만 해석되므로, 기본을 꺼 두면 디스크 서버 없이 쓰는 경로에서
// 켤 방법이 없어진다. pd_protocol_ids.h 의 PD_CMD_CTRL 주석 참조.
void pd_midipac_set_enabled(bool on);
bool pd_midipac_enabled(void);

void pd_midipac_set_stream(bool on);   // PSG 원음
bool pd_midipac_stream(void);

void pd_midipac_set_midi(bool on);     // MIDI-PAC. 끄면 울리던 음을 끈다
bool pd_midipac_midi(void);

// 진단용. "소리가 안 난다" 일 때 제일 먼저 볼 값이다 —
// 0 이면 PSG 쓰기가 아예 안 잡히고 있다는 뜻이라 원인이 버스 쪽이다.
uint32_t pd_midipac_psg_writes(void);
uint32_t pd_midipac_notes_sent(void);

// multirom.c 가 제공한다. core1 에서만 부른다 - core0 이 I/O FIFO 를 비우지 않는
// 모드(평범한 ROM 서빙)에서 대신 비워 PSG 쓰기를 건져 온다.
void pd_io_drain_psg(void);

// core0 이 CDC 링과 I/O FIFO 를 쥐고 있는 모드인가 (Sunrise·매퍼).
// 참이면 core1 은 둘 다 건드리지 않는다 - 링은 생산자가 하나여야 한다.
extern volatile bool pd_io_fifo_core0;

#endif // PD_MIDIPAC_H
