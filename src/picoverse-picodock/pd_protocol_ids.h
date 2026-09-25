// pd_protocol_ids.h — frame constants shared by the firmware and the host.
//
// The wire format is documented in ../pd_protocol.md:
//
//     [0x5A][CMD][LEN_LO][LEN_HI][payload ...][CHK]
//     CHK = CMD ^ LEN_LO ^ LEN_HI ^ payload[*]
//
// Kept in its own header so both the block backend (sunrise_ide.c) and anything
// else that speaks the protocol agree on the numbers without pulling in the
// mailbox or IDE headers.

#ifndef PD_PROTOCOL_IDS_H
#define PD_PROTOCOL_IDS_H

#define PD_SOF                0x5Au

// 0x10/0x11 were the ROM list (host serves a folder, the menu lists it). That
// track was dropped - SofaRun reads ROMs off the virtual disk and does the job
// better - so the pair is free. See archive/README.md.

// Block device (cartridge <-> host, never passes through the MSX) — D4
#define PD_BLK_INFO_REQ       0x20u   // -> host : none
#define PD_BLK_INFO_RESP      0x21u   // <- host : [st:1][block_count:4][block_size:2]
#define PD_BLK_READ_REQ       0x22u   // -> host : [lba:4][count:1]
#define PD_BLK_READ_RESP      0x23u   // <- host : [st:1][data: count*512]
#define PD_BLK_WRITE_REQ      0x24u   // -> host : [lba:4][count:1][data: count*512]
#define PD_BLK_WRITE_RESP     0x25u   // <- host : [st:1]

// Mailbox bytes multiplexed onto the same pipe as the block protocol — B0.
//
// The MSX reaches the mailbox from MSX-DOS, which is exactly when the block
// backend owns the CDC link, so mailbox traffic cannot go out raw: it would
// land inside a block frame. It gets its own command instead, and the block
// backend relays it. Payload is an opaque run of bytes, no framing of its own -
// any protocol the MSX and host agree on is layered on top.
#define PD_CMD_MB_TO_HOST     0x30u   // -> host : [bytes...] from the MSX
#define PD_CMD_MB_TO_MSX      0x31u   // <- host : [bytes...] for the MSX

// Virtual printer (cartridge -> host), multiplexed onto the same pipe — printer
// merge. Payload is a run of captured MSX print bytes; the host reassembles the
// job by idle timeout, as it always did for the standalone printer firmware.
#define PD_CMD_PRINT_DATA     0x40u   // -> host : [bytes...] printed by the MSX

// PSG 원음 스트림 (cartridge -> host). MIDI 로 옮기면 음색이 GM 악기가 되어
// 사각파가 사라진다. 레지스터를 그대로 보내고 맥이 AY-3-8910 을 흉내 내면
// 본체 PSG 와 같은 소리가 난다 - 본체 음원이 고장난 기계를 대신할 수 있다.
//
// 한 프레임에 레지스터 한 벌을 통째로 싣는다. MSX 음악은 대부분 VBLANK 마다
// 레지스터를 쓰므로 50 Hz 스냅샷이면 잃는 것이 거의 없고, 개별 쓰기를 추적하는
// 것보다 단순하고 유실에도 강하다. 750 B/s 라 대역폭은 없는 셈이다.
//
// flags 비트 0 = 이 프레임에 R13(엔벨로프 모양)이 쓰였다. 값이 같아도 다시
// 쓰면 엔벨로프가 처음부터 도므로, 값만 봐서는 알 수 없다.
// seq 는 20 ms 틱마다 오르고 (보냈든 걸렀든), drops 는 CDC 에 자리가 없어 거른
// 수다. 맥에서 본 구멍이 어디서 났는지 이 둘로 갈린다 - pd_midipac.c 참고.
#define PD_CMD_PSG_FRAME      0x50u   // -> host : [R0..R13:14][flags:1][seq:1][drops:1]

// 음성 (host -> cartridge -> MSX). 카트리지는 링에 담아 두고, MSX 가
// 0x7F0C 를 읽을 때마다 한 바이트씩 내어 준다 - pd_voice_win.h 참고.
//
// 왜 바이트 그대로인가: 합성도 PSG 볼륨 표로의 변환도 호스트에서 끝난다
// (src/host/pd_voice.py). 카트리지가 할 일은 나르는 것뿐이고, Z80 이 할 일은
// 읽어서 PSG 에 붓는 것뿐이다. 무거운 계산을 양쪽 끝에서 멀리 두는 것이
// 이 기능이 8 비트 기계에서 되는 이유다.
//
// 한 프레임에 512 바이트까지만 싣는다. 같은 파이프로 디스크 섹터가 오가므로,
// 4KB 를 한 번에 밀어 넣으면 그동안 섹터 읽기가 멈춘다 - 멈춘 디스크는 MSX 가
// 포기한다. 섹터 하나와 비슷한 덩어리면 서로를 굶기지 않는다.
#define PD_CMD_VOICE_DATA     0x70u   // -> cart : [samples...]
#define PD_CMD_VOICE_CTRL     0x71u   // -> cart : [what:1]
#define PD_VOICE_RESET        0x00u   //   버리고 처음으로
#define PD_VOICE_CLOSE        0x01u   //   더 올 것이 없다 (남은 것은 마저 난다)

// 음성 상태 (cartridge -> host). **흐름 제어가 이것 하나에 달려 있다.**
// 링은 4KB(11 kHz 에서 0.37 초)뿐이라 호스트가 눈감고 밀어 넣으면 넘친다.
// 시계로만 맞추는 방법도 있지만, MSX 가 아직 시작을 안 눌렀으면 링은 안 비고
// 시계는 그것을 모른다. 그래서 카트리지가 자리를 말해 준다.
//
// underruns 는 MSX 가 호스트보다 빨랐던 횟수다. 0 이 아니면 소리에 구멍이
// 났다는 뜻이고, 그것은 화면에 보여야 한다 - 안 보이면 "왜 뚝뚝 끊기지" 가 된다.
#define PD_CMD_VOICE_STAT     0x72u   // -> host : [room:2][played:4][flags:1]
#define PD_VOICE_ST_ARMED     0x01u   //   MSX 가 시작을 눌렀다
#define PD_VOICE_ST_STARVED   0x02u   //   한 번이라도 굶었다
#define PD_VOICE_ST_ENDED     0x04u   //   닫혔고 다 나갔다

// 카트리지 자신에게 내리는 지시 (host -> cartridge). 다른 명령들과 달리 MSX 로
// 중계되지 않고 여기서 끝난다.
//
// 왜 필요한가: MIDI-PAC 은 USB-MIDI 엔드포인트로 **호스트 프로그램을 거치지 않고**
// 나간다. 그래서 맥에서 "끈다" 는 것이 불가능했다 - 받아서 버릴 파이프가 없다.
// PSG 원음은 CDC 로 오므로 호스트가 버릴 수는 있지만, 그래도 대역은 이미 쓴 뒤다.
// 둘 다 근원에서 끄는 편이 낫다.
//
// 주의: 이 명령은 **Sunrise 모드에서만 해석된다** (rx_sink 가 그때만 걸린다).
// 그래서 펌웨어 기본값은 둘 다 **켜짐**이어야 한다 - 디스크 서버 없이 쓰는
// 경로에서는 켜 줄 사람이 없기 때문이다. 서버가 붙으면서 자기 기본값(꺼짐)을
// 밀어 넣는다.
#define PD_CMD_CTRL           0x60u   // -> cart : [what:1][on:1]
#define PD_CTRL_PSG_STREAM    0x01u   //   PSG 원음 프레임 (0x50) 을 보낼 것인가
#define PD_CTRL_MIDIPAC       0x02u   //   PSG -> MIDI 변환을 내보낼 것인가
#define PD_CTRL_MIDI_PROG     0x03u   //   톤 채널의 GM 악기 (0..127)
                                      //   여기서는 둘째 바이트가 켜고 끄는
                                      //   값이 아니라 프로그램 번호다.

#endif // PD_PROTOCOL_IDS_H
