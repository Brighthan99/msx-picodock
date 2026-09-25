// SPDX-License-Identifier: GPL-2.0-only
//
// protocol.js — 카트리지와 주고받는 프레임 상수.
//
// **src/picoverse-picodock/pd_protocol_ids.h 와 같은 값이어야 한다.** 한쪽만
// 고치면 조용히 어긋난다 - 프레임은 checksum 만 맞으면 통과하므로, 명령 번호가
// 틀려도 오류가 아니라 "모르는 명령" 으로 조용히 버려진다.
//
//     [0x5A][CMD][LEN_LO][LEN_HI][payload ...][CHK]
//     CHK = CMD ^ LEN_LO ^ LEN_HI ^ payload[*]

export const SOF = 0x5a;

// 블록 장치 (카트리지 <-> 호스트, MSX 를 거치지 않는다)
export const BLK_INFO_REQ   = 0x20;   // -> host : 없음
export const BLK_INFO_RESP  = 0x21;   // <- host : [st:1][block_count:4][block_size:2]
export const BLK_READ_REQ   = 0x22;   // -> host : [lba:4][count:1]
export const BLK_READ_RESP  = 0x23;   // <- host : [st:1][data: count*512]
export const BLK_WRITE_REQ  = 0x24;   // -> host : [lba:4][count:1][data]
export const BLK_WRITE_RESP = 0x25;   // <- host : [st:1]

// 메일박스 (CALL PDASK) — 같은 파이프에 실린다
export const MB_TO_HOST = 0x30;
export const MB_TO_MSX  = 0x31;

export const PRINT_DATA = 0x40;       // 프린터 바이트, 카트리지 -> 호스트
export const PSG_FRAME  = 0x50;       // [R0..R13:14][flags:1][seq:1][drops:1]

// 카트리지 자신에게 내리는 지시. MSX 로 중계되지 않는다.
// 음성. 카트리지 안의 링으로 흘려보내고, 링이 얼마나 비었는지 돌려받는다.
// 흐름 제어가 VOICE_STAT 하나에 달려 있다 - src/picoverse-picodock/pd_voice_win.h
export const VOICE_DATA = 0x70;       // -> cart : [samples...]
export const VOICE_CTRL = 0x71;       // -> cart : [what:1]  0=reset 1=close
export const VOICE_STAT = 0x72;       // <- cart : [room:2][played:4][flags:1]

export const CTRL            = 0x60;  // -> cart : [what:1][on:1]
export const CTRL_PSG_STREAM = 0x01;
export const CTRL_MIDIPAC    = 0x02;
// 여기만 둘째 바이트가 켜고 끄는 값이 아니라 GM 악기 번호(0..127)다.
export const CTRL_MIDI_PROG  = 0x03;

export const SECTOR = 512;
export const ST_OK = 0x00;
export const ST_ERR = 0x01;

// 넉넉하게. 오늘의 요청은 한 섹터지만 count 가 붙을 수 있다.
export const MAX_PAYLOAD = 1 + SECTOR * 4;
