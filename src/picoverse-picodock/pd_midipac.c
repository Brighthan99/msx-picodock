// pd_midipac.c — PSG 를 엿듣고 MIDI 로 옮겨 적는다. 설명은 pd_midipac.h 참조.

#include <string.h>

#include "pico/stdlib.h"
#include "hardware/sync.h"
#include "tusb.h"

#include "pd_midipac.h"
#include "pd_usb.h"
#include "pd_protocol_ids.h"
#include "pd_msxmidi.h"

// -----------------------------------------------------------------------
// 튜닝 상수
// -----------------------------------------------------------------------
#define FRAME_US        20000u  // 50 Hz. MIDI-PAC 과 같은 프레임률
#define MIDI_CABLE      0
#define CH_TONE_BASE    0       // 톤 3성 -> MIDI 채널 0,1,2
#define CH_DRUM         9       // GM 리듬 채널 (1-based 로 10)
#define PROG_SQUARE     80      // GM Lead 1 (square) — PSG 사각파에 가장 가깝다

// 실제로 쓰는 악기. 기본값은 위의 사각파이고, 호스트가 PD_CTRL_MIDI_PROG 로
// 바꿀 수 있다.
//
// **왜 런타임에 바꿀 수 있어야 하는가.** GM 악기 번호는 규격이지만 그 번호가
// 어떤 소리를 내는지는 사운드폰트가 정한다. 같은 80 번이 어떤 폰트에서는
// 칩튠처럼 거칠고 어떤 폰트에서는 부드러운 리드다 - 실제로 FluidR3 의
// Square Lead 는 엔벨로프 감쇠가 얹히면 피아노처럼 들린다(2026-09-21).
// 어느 쪽이 좋은지는 듣는 사람이 정할 일이지 펌웨어가 정할 일이 아니다.
//
// 저장하지 않는다. 서버가 붙을 때마다 다시 밀어 넣는다 - PSG 스트림·MIDI-PAC
// 스위치와 같은 규율이고, 설정이 한 군데(호스트)에만 있게 된다.
static volatile uint8_t midi_prog = PROG_SQUARE;
static volatile bool    midi_prog_dirty;   // 바뀌었으니 곧 다시 주장할 것
#define BEND_RANGE      2       // 반음. RPN 으로 음원에 알려 준다

// 음이 흔들려도 다시 치지 않는 폭. 이 안이면 피치벤드로 표현한다.
#define BEND_WINDOW_CENTS 100

// -----------------------------------------------------------------------
// PSG 그림자 — core0 이 쓰고 core1 이 읽는다 (seqlock)
// -----------------------------------------------------------------------
static volatile uint8_t  psg[16];
static volatile uint32_t psg_seq;          // 짝수 = 안정, 홀수 = 쓰는 중
static volatile uint8_t  psg_latched_reg;  // 0xA0 으로 고른 레지스터
static volatile uint32_t psg_write_count;
// 엔벨로프 재시작은 **값이 같아도** 일어난다. R13 에 쓰기만 하면 처음부터 다시
// 돈다 - 50 Hz 스냅샷으로는 "또 썼다" 와 "안 썼다" 를 구별할 수 없으므로
// 쓰기를 센다.
//
// **불린이 아니라 세는 수인 이유:** 이 신호를 보는 쪽이 둘이다 - PSG 원음
// 스트림(호스트 렌더러에게 알려 준다)과 카트리지 자신의 MIDI-PAC. 불린 하나를
// 나눠 쓰면 먼저 본 쪽이 지워 버려서 다른 쪽은 영영 못 본다. 실제로 그랬다:
// 스트림만 읽고 지워서 MIDI-PAC 의 엔벨로프가 한 번 내려간 뒤 영영 0 에
// 머물렀고, 엔벨로프로만 소리를 내는 게임은 MIDI 가 통째로 안 나갔다
// (2026-09-21 실기에서 발견).
//
// 세는 수를 두고 보는 쪽마다 제가 마지막에 본 값을 기억하면 서로 안 뺏는다.
static volatile uint32_t psg_r13_writes;
static volatile bool     enabled = true;
static volatile bool     stream_on = true;   // PSG 원음 (0x50)
static volatile bool     midi_on = true;      // PSG -> MIDI

static uint32_t notes_sent;
static uint32_t psg_frames_dropped;   // 자리가 없어 거른 수
static uint32_t psg_seq_no;           // 20 ms 틱마다 오른다 (보냈든 걸렀든)

void __not_in_flash_func(pd_midipac_io_write)(uint16_t port, uint8_t data)
{
    const uint8_t p = (uint8_t)(port & 0xFFu);

    if (p == PSG_PORT_ADDR) {
        psg_latched_reg = (uint8_t)(data & 0x0Fu);
        return;
    }
    if (p != PSG_PORT_DATA)
        return;                     // PSG 와 무관한 I/O 쓰기 — 그냥 지나간다

    const uint8_t r = psg_latched_reg;

    // R14/R15 는 조이스틱·키보드용 I/O 포트다. 소리와 무관하니 건드리지 않는다.
    if (r >= 14u)
        return;

    psg_seq++;                      // 홀수 = 쓰는 중
    __dmb();
    psg[r] = data;
    if (r == 13u)
        psg_r13_writes++;
    __dmb();
    psg_seq++;                      // 짝수 = 안정
    psg_write_count++;
}

// 찢어지지 않은 한 벌을 뜬다. 쓰기가 끼어들면 다시 읽는다.
static void psg_snapshot(uint8_t out[16])
{
    for (;;) {
        const uint32_t s1 = psg_seq;
        if (s1 & 1u)
            continue;               // 쓰는 중
        __dmb();
        for (int i = 0; i < 16; i++)
            out[i] = psg[i];
        __dmb();
        if (psg_seq == s1)
            return;
    }
}

// -----------------------------------------------------------------------
// 음정 — MIDI 노트별 PSG 주기표
// -----------------------------------------------------------------------
// TP = 1,789,772.5 / (16 x f).  값이 클수록 낮은 음이라 표는 내림차순이다.
// 21번(A0) 아래는 12비트 주기로 표현되지 않아 4095 로 잘려 있다.
static const uint16_t note_period[128] = {
#include "psg_note_table.inc"
};
#define NOTE_MIN 21

// 주기를 노트와 센트 오차로 나눈다. 표가 내림차순이라 이분 탐색이 그대로 먹는다.
static void period_to_note(uint16_t tp, uint8_t *note_out, int *cents_out)
{
    if (tp == 0) {                  // 주기 0 = 오실레이터 정지. 음이 아니다.
        *note_out = 0;
        *cents_out = 0;
        return;
    }

    int lo = NOTE_MIN, hi = 127;
    while (lo < hi) {
        const int mid = (lo + hi) / 2;
        if (note_period[mid] > tp)  // 아직 낮은 음 쪽
            lo = mid + 1;
        else
            hi = mid;
    }

    // lo 는 tp 이하의 주기를 갖는 첫 노트. 한 칸 아래와 견줘 가까운 쪽을 고른다.
    int n = lo;
    if (n > NOTE_MIN) {
        const int d_hi = (int)tp - (int)note_period[n];
        const int d_lo = (int)note_period[n - 1] - (int)tp;
        if (d_lo < d_hi)
            n = n - 1;
    }

    // 센트 오차. 반음이 주기비로 약 5.95% 이므로 선형 근사로 충분하다.
    const int ref = note_period[n];
    const int diff = ref - (int)tp;             // 주기가 짧으면 음이 높다
    *cents_out = (ref > 0) ? (diff * 1700) / ref : 0;  // 100센트 ~ 5.95% -> 1700
    *note_out = (uint8_t)n;
}

// -----------------------------------------------------------------------
// 엔벨로프 — 음량 레지스터의 비트4 가 서면 음량을 이쪽이 지배한다
// -----------------------------------------------------------------------
// 32단 카운터를 50 Hz 프레임마다 진행시킨다. 원래 칩은 훨씬 잘게 움직이지만,
// 화면 주사율로 샘플링해도 감쇠·반복의 인상은 살아난다. 정확한 재현은 아니다.
static uint8_t  env_step;        // 0..31
static bool     env_rising;      // 지금 올라가는 중인가
static bool     env_holding;     // 더 움직이지 않고 한 값에 머무는 중
static uint8_t  env_hold_level;
static uint8_t  env_shape_prev = 0xFFu;
static uint32_t env_accum;       // 프레임 사이에 남은 소수 스텝 (16.16)

static uint8_t envelope_level(const uint8_t s[16])
{
    const uint8_t shape = (uint8_t)(s[13] & 0x0Fu);
    const bool cont = (shape & 0x08u) != 0;
    const bool att  = (shape & 0x04u) != 0;
    const bool alt  = (shape & 0x02u) != 0;
    const bool hold = (shape & 0x01u) != 0;

    // R13 에 값을 쓰면 모양과 무관하게 엔벨로프가 처음부터 다시 돈다.
    //
    // 주석은 처음부터 이렇게 적혀 있었는데 코드는 **값이 바뀔 때만** 리셋하고
    // 있었다. 같은 값(흔히 0x00)을 되풀이해 쓰는 게임에서는 엔벨로프가 한 번
    // 내려간 뒤 영영 0 에 머물러서, 볼륨을 엔벨로프로만 내는 곡이 통째로
    // 조용했다. 카트리지는 I/O 쓰기를 직접 보므로 셀 수 있다.
    static uint32_t env_seen;
    const uint32_t now13 = psg_r13_writes;
    const bool rewritten = (now13 != env_seen);
    env_seen = now13;

    if (rewritten || shape != env_shape_prev) {
        env_shape_prev = shape;
        env_step    = 0;
        env_rising  = att;
        env_holding = false;
        env_accum   = 0;
    }

    if (env_holding)
        return env_hold_level;

    uint32_t ep = (uint32_t)s[11] | ((uint32_t)s[12] << 8);
    if (ep == 0) ep = 1;
    // 스텝/초 = 1,789,772.5 / (8 x EP). 프레임(1/50 초)당 스텝수를 16.16 으로.
    const uint32_t steps_q16 = (uint32_t)((1789772ull * 65536ull) / (8ull * (uint64_t)ep * 50ull));
    env_accum += steps_q16;
    uint32_t whole = env_accum >> 16;
    env_accum &= 0xFFFFu;
    if (whole > 64u) whole = 64u;   // 아주 짧은 주기는 귀가 못 따라온다

    while (whole--) {
        if (env_step < 31u) {
            env_step++;
            continue;
        }

        // 한 바퀴가 끝났다.
        if (!cont) {
            // 모양 0~7. 한 번 지나간 뒤 0 으로 떨어져 머문다.
            env_holding = true;
            env_hold_level = 0;
            return 0;
        }
        if (hold) {
            // 모양 9·11·13·15. 끝값에 머문다.
            // 9(att0,alt0)=0, 11(att0,alt1)=15, 13(att1,alt0)=15, 15(att1,alt1)=0.
            env_holding = true;
            env_hold_level = (att != alt) ? 15u : 0u;
            return env_hold_level;
        }
        // 모양 8·10·12·14. 되풀이하고, alt 면 방향을 뒤집는다.
        env_step = 0;
        if (alt)
            env_rising = !env_rising;
    }

    const uint8_t lvl32 = env_rising ? env_step : (uint8_t)(31u - env_step);
    return (uint8_t)(lvl32 >> 1);   // 32단 -> PSG 의 16단
}

// -----------------------------------------------------------------------
// MIDI 내보내기 — 전부 core1 에서만
// -----------------------------------------------------------------------
static void midi_out(const uint8_t *b, uint32_t n)
{
    if (tud_midi_mounted())
        tud_midi_stream_write(MIDI_CABLE, b, n);
}

static void midi_note_on(uint8_t ch, uint8_t note, uint8_t vel)
{
    const uint8_t m[3] = { (uint8_t)(0x90u | ch), note, vel };
    midi_out(m, 3);
    notes_sent++;
}

static void midi_note_off(uint8_t ch, uint8_t note)
{
    const uint8_t m[3] = { (uint8_t)(0x80u | ch), note, 0 };
    midi_out(m, 3);
}

static void midi_bend(uint8_t ch, int cents)
{
    int v = 8192 + (cents * 8192) / (BEND_RANGE * 100);
    if (v < 0) v = 0;
    if (v > 16383) v = 16383;
    const uint8_t m[3] = { (uint8_t)(0xE0u | ch), (uint8_t)(v & 0x7Fu), (uint8_t)((v >> 7) & 0x7Fu) };
    midi_out(m, 3);
}

static void midi_expression(uint8_t ch, uint8_t v)
{
    const uint8_t m[3] = { (uint8_t)(0xB0u | ch), 11u, (uint8_t)(v & 0x7Fu) };
    midi_out(m, 3);
}

// PSG 음량은 로그 눈금이라 그대로 쓰면 작은 값이 안 들린다. 아래쪽을 들어올린다.
static const uint8_t vol_to_vel[16] = {
    0, 24, 33, 41, 49, 56, 63, 70, 77, 84, 91, 98, 105, 112, 119, 127
};

// 노이즈 주기를 여섯 구간으로 나눠 GM 타악기에 배정한다.
// 성부마다 다른 악기를 줘서 세 노이즈가 같은 드럼으로 뭉치지 않게 한다.
static const uint8_t noise_drum[3][6] = {
    { 42, 44, 38, 40, 45, 41 },   // 닫힌 하이햇 · 페달 · 스네어 · 림 · 탐
    { 46, 42, 40, 38, 47, 43 },   // 열린 하이햇 계열
    { 49, 51, 39, 37, 48, 36 },   // 크래시 · 라이드 · 클랩 · 킥
};

// -----------------------------------------------------------------------
// 성부 상태
// -----------------------------------------------------------------------
typedef struct {
    bool     sounding;
    uint8_t  note;
    int      cents;
    uint8_t  vel;
    uint8_t  stable;      // 새 음 중심이 몇 프레임째 유지되는가
    uint8_t  pending;
} voice_t;

static voice_t tone_voice[3];
static bool    drum_on[3];
static uint8_t drum_note[3];
static uint64_t next_frame_us;

void pd_midipac_init(void)
{
    memset((void *)psg, 0, sizeof(psg));
    psg[7] = 0x3Fu;                 // 믹서: 전부 꺼짐이 전원투입 기본값
    memset(tone_voice, 0, sizeof(tone_voice));
    memset(drum_on, 0, sizeof(drum_on));
    next_frame_us = time_us_64();
}

// 음원을 알려진 상태에서 출발시킨다. 장치가 붙은 직후 한 번만.
// 채널 한 벌의 음색 설정. 되풀이해도 안전한 것만 들어간다.
static void midi_channel_setup(uint8_t ch)
{
    const uint8_t pc[2] = { (uint8_t)(0xC0u | ch), (uint8_t)(midi_prog & 0x7Fu) };
    midi_out(pc, 2);
    // 피치벤드 폭을 ±2 반음으로. RPN 0,0.
    const uint8_t rpn[12] = {
        (uint8_t)(0xB0u | ch), 101, 0, (uint8_t)(0xB0u | ch), 100, 0,
        (uint8_t)(0xB0u | ch),   6, BEND_RANGE, (uint8_t)(0xB0u | ch), 38, 0
    };
    midi_out(rpn, sizeof(rpn));
    midi_expression(ch, 127);
}

static void midi_setup(void)
{
    static const uint8_t gm_on[6] = { 0xF0, 0x7E, 0x7F, 0x09, 0x01, 0xF7 };
    midi_out(gm_on, sizeof(gm_on));

    for (uint8_t c = 0; c < 3; c++)
        midi_channel_setup((uint8_t)(CH_TONE_BASE + c));
}

// 음원을 나중에 켜도 몇 초 안에 제자리를 찾게 한다.
//
// 프로그램 체인지는 USB 가 붙는 순간 **한 번만** 나갔다. 그런데 맥은 카트리지를
// 꽂는 즉시 CoreMIDI 가 장치를 잡으므로, 한참 뒤에 띄운 신디사이저는 그것을 못
// 받는다. 그러면 GM 기본값인 **프로그램 0 = 어쿠스틱 그랜드 피아노**로 울린다 -
// 2026-09-13 에 실제로 그렇게 들렸고, 채널 0·1·2 를 손으로 80 으로 바꾸고서야
// 사각파 리드가 나왔다.
//
// **GM 리셋(F0 7E 7F 09 01 F7)은 여기서 다시 보내지 않는다.** 그것은 울리던
// 음과 컨트롤러를 통째로 지우므로, 연주 중에 2 초마다 보내면 그대로 들린다.
// 되풀이하는 것은 채널마다의 프로그램·벤드폭·익스프레션뿐이다.
//
// 그리고 **울리고 있지 않은 채널에만** 보낸다. 음이 나가는 중에 음색을 바꾸면
// 그것도 들린다. MSX 음악은 성부가 쉬는 순간이 잦아서, 몇 초면 세 채널이 모두
// 한 번씩은 조용해진다 - 드물게 계속 우는 성부가 있어도 나머지는 맞춰진다.
static void midi_reassert(void)
{
    for (uint8_t c = 0; c < 3; c++) {
        if (tone_voice[c].sounding)
            continue;
        midi_channel_setup((uint8_t)(CH_TONE_BASE + c));
    }
}

static void all_notes_off(void)
{
    for (uint8_t c = 0; c < 3; c++) {
        if (tone_voice[c].sounding) {
            midi_note_off((uint8_t)(CH_TONE_BASE + c), tone_voice[c].note);
            tone_voice[c].sounding = false;
        }
        if (drum_on[c]) {
            midi_note_off(CH_DRUM, drum_note[c]);
            drum_on[c] = false;
        }
    }
}

static void frame(const uint8_t s[16])
{
    const uint8_t mixer = s[7];
    const uint8_t env_lvl = envelope_level(s);

    for (uint8_t c = 0; c < 3; c++) {
        const uint8_t ch = (uint8_t)(CH_TONE_BASE + c);
        const bool tone_en  = ((mixer >> c) & 1u) == 0u;
        const bool noise_en = ((mixer >> (3 + c)) & 1u) == 0u;

        const uint8_t amp = s[8 + c];
        const uint8_t vol = (amp & 0x10u) ? env_lvl : (uint8_t)(amp & 0x0Fu);

        const uint16_t tp = (uint16_t)(s[2 * c] | ((uint16_t)(s[2 * c + 1] & 0x0Fu) << 8));

        // ---- 톤 ----
        // 주기 0 은 음이 아니라 오실레이터 정지다. msx-picopsg 의 음성 합성이
        // 바로 그 상태에서 볼륨을 DAC 으로 쓴다 — 음으로 옮기면 안 된다.
        const bool want = tone_en && vol > 0u && tp > 0u;

        if (!want) {
            if (tone_voice[c].sounding) {
                midi_note_off(ch, tone_voice[c].note);
                tone_voice[c].sounding = false;
            }
        } else {
            uint8_t n; int cents;
            period_to_note(tp, &n, &cents);

            if (!tone_voice[c].sounding) {
                tone_voice[c].note = n;
                tone_voice[c].vel  = vol_to_vel[vol];
                midi_bend(ch, cents);
                midi_note_on(ch, n, tone_voice[c].vel);
                tone_voice[c].sounding = true;
                tone_voice[c].cents = cents;
                tone_voice[c].stable = 0;
                tone_voice[c].pending = n;
            } else {
                const int delta_semis = (int)n - (int)tone_voice[c].note;
                const int total_cents = delta_semis * 100 + cents;

                if (delta_semis == 0 ||
                    (total_cents > -BEND_WINDOW_CENTS && total_cents < BEND_WINDOW_CENTS)) {
                    // 같은 음 주변의 흔들림 — 다시 치지 않고 벤드로 표현한다.
                    if (total_cents != tone_voice[c].cents) {
                        midi_bend(ch, total_cents);
                        tone_voice[c].cents = total_cents;
                    }
                    tone_voice[c].stable = 0;
                } else if (delta_semis > 2 || delta_semis < -2) {
                    // 반음 둘을 넘게 뛰면 효과음이나 아르페지오다. 바로 갈아탄다.
                    midi_note_off(ch, tone_voice[c].note);
                    midi_bend(ch, cents);
                    midi_note_on(ch, n, vol_to_vel[vol]);
                    tone_voice[c].note = n;
                    tone_voice[c].cents = cents;
                    tone_voice[c].stable = 0;
                } else {
                    // 애매한 폭 — 몇 프레임 유지될 때만 새 음으로 인정한다.
                    if (tone_voice[c].pending == n) {
                        if (++tone_voice[c].stable >= 2u) {
                            midi_note_off(ch, tone_voice[c].note);
                            midi_bend(ch, cents);
                            midi_note_on(ch, n, vol_to_vel[vol]);
                            tone_voice[c].note = n;
                            tone_voice[c].cents = cents;
                            tone_voice[c].stable = 0;
                        }
                    } else {
                        tone_voice[c].pending = n;
                        tone_voice[c].stable = 0;
                    }
                }

                if (tone_voice[c].vel != vol_to_vel[vol]) {
                    tone_voice[c].vel = vol_to_vel[vol];
                    midi_expression(ch, tone_voice[c].vel);
                }
            }
        }

        // ---- 노이즈 -> 타악기 ----
        const bool nwant = noise_en && vol > 0u;
        if (!nwant) {
            if (drum_on[c]) {
                midi_note_off(CH_DRUM, drum_note[c]);
                drum_on[c] = false;
            }
        } else {
            const uint8_t np = (uint8_t)(s[6] & 0x1Fu);
            const uint8_t band = (uint8_t)(np / 6u > 5u ? 5u : np / 6u);
            const uint8_t dn = noise_drum[c][band];
            if (!drum_on[c] || drum_note[c] != dn) {
                if (drum_on[c])
                    midi_note_off(CH_DRUM, drum_note[c]);
                midi_note_on(CH_DRUM, dn, vol_to_vel[vol]);
                drum_note[c] = dn;
                drum_on[c] = true;
            }
        }
    }
}

// PSG 한 벌을 프레임으로 호스트에 보낸다.
//
// Sunrise 모드에서도 보낸다 - 디스크와 소리를 **동시에** 쓸 수 있어야 한다.
// 예전에는 pd_io_fifo_core0 으로 통째로 막았는데, 막은 이유는 "core0 이 쓴다"
// 가 아니라 **블록 프레임이 여러 번에 나눠 나가기 때문**이었다(blk_tx_pump 는
// 자리가 나는 만큼만 밀어 넣는다). 그 사이에 22 바이트가 끼면 찢어진다.
//
// 그래서 모드가 아니라 **상태**를 묻는다. 프레임이 반쯤 나가 있는 동안만
// 비켜서면 되고, 그동안 거른 틱은 호스트가 seq 를 보고 직전 레지스터로 채운다
// (pd_psgplay 의 잃은 프레임 채우기). 디스크가 바쁠 때 소리가 조금 낡을 뿐
// 끊기지 않는다.
static void psg_stream_frame(const uint8_t s[16])
{
    if (pd_usb_pipe_busy())
        return;

    // 자리가 모자라면 **아예 보내지 않는다.** 잘려 나간 프레임은 받는 쪽에서
    // 다음 SOF 까지 버려지므로, 한 프레임을 거르는 것보다 훨씬 큰 구멍이 된다.
    // 20 바이트가 다 들어갈 때만 쓴다.
    if (pd_usb_write_room() < 22u) {
        psg_frames_dropped++;
        return;
    }

    uint8_t f[23];
    f[0] = PD_SOF;
    f[1] = PD_CMD_PSG_FRAME;
    f[2] = 17u; f[3] = 0u;
    for (int i = 0; i < 14; i++)
        f[4 + i] = s[i];
    // 제가 마지막에 본 값만 기억한다. 지우지 않으므로 MIDI-PAC 이 볼 것을
    // 뺏지 않는다.
    static uint32_t stream_seen;
    const uint32_t now13 = psg_r13_writes;
    f[18] = (now13 != stream_seen) ? 1u : 0u;
    stream_seen = now13;
    // 구멍이 어디서 생겼는지 받는 쪽이 알 수 있게 카트리지가 직접 말한다.
    // seq 는 20 ms 틱마다 오르고 - 보냈든 걸렀든 - drops 는 자리가 없어 거른
    // 수다. 맥에서 400 ms 구멍을 봤을 때 셋을 맞춰 보면 답이 하나로 갈린다:
    //   seq 가 20 올랐고 drops 그대로  -> 보냈는데 오는 길에 잃었다 (USB/호스트)
    //   seq 가 20 올랐고 drops 도 20   -> 자리가 없어 못 썼다 (호스트가 안 읽는다)
    //   seq 가 1 밖에 안 올랐다        -> 카트리지가 그동안 안 돌았다 (core1 멈춤)
    f[19] = (uint8_t)psg_seq_no;
    f[20] = (uint8_t)psg_frames_dropped;

    uint8_t chk = 0;
    for (int i = 1; i < 21; i++)
        chk ^= f[i];
    f[21] = chk;

    pd_usb_write(f, 22u);
}

void __not_in_flash_func(pd_midipac_task)(void)
{
    static bool was_mounted;

    const bool mounted = tud_midi_mounted();
    if (mounted && !was_mounted) {
        midi_setup();               // 맥이 포트를 열었다 — 알려진 상태에서 출발
        was_mounted = true;
    } else if (!mounted && was_mounted) {
        memset(tone_voice, 0, sizeof(tone_voice));
        memset(drum_on, 0, sizeof(drum_on));
        was_mounted = false;
    }

    pd_io_drain_psg();          // ROM 서빙 모드에서는 여기서만 FIFO 가 비워진다

    const uint64_t now = time_us_64();
    if (now < next_frame_us)
        return;
    // now + FRAME_US 가 아니라 **누적** 이다. 전자는 매번 "여기서 20 ms 뒤" 라
    // 늦은 만큼이 주기에 쌓여 50 Hz 를 늘 조금씩 밑돈다. 맥은 한 프레임을
    // 20 ms 로 세므로 그 차이만큼 링이 서서히 마른다.
    next_frame_us += FRAME_US;
    if (next_frame_us < now)    // 오래 멈춰 있었다 - 밀린 프레임은 버리고 맞춘다
        next_frame_us = now + FRAME_US;
    psg_seq_no++;               // 거르더라도 오른다 - 그래야 구멍이 드러난다

    if (!enabled)
        return;

    uint8_t s[16];
    psg_snapshot(s);

    // 원음 스트림은 시리얼로 나가므로 MIDI 가 붙었는지와 무관하다.
    // 여기를 mounted 뒤에 두면 맥에서 MIDI 앱을 안 켰을 때 원음도 끊긴다.
    if (stream_on)
        psg_stream_frame(s);

    // MSX 가 직접 MIDI 를 내보내는 중이면 (MIDRY 등) 우리는 입을 다문다.
    //
    // 두 가지 이유가 있다. 하나는 같은 케이블에 둘이 쓰면 메시지가 섞여
    // 러닝 스테이터스가 깨진다는 것 - tud_midi_stream_write() 는 케이블마다
    // 상태를 하나만 들고 있어서, 한쪽의 미완성 메시지 사이에 다른 쪽 바이트가
    // 끼면 음원이 엉뚱하게 해석한다. 다른 하나는 음악이 겹친다는 것이다.
    // 원본이 있는데 PSG 를 번역한 것까지 같이 울릴 이유가 없다.
    //
    // 1 초는 MIDI 파일 한 곡 안의 가장 긴 쉼보다 넉넉히 길고, 연주가 끝난 뒤
    // PSG 로 돌아오는 것을 기다리기에는 짧다.
    static bool hushed;
    const bool msx_midi_live = pd_msxmidi_idle_us() < 1000000u;
    if (msx_midi_live)
    {
        if (!hushed && mounted)
            all_notes_off();      // 울리던 음을 남기고 물러나지 않는다
        hushed = true;
        return;
    }
    hushed = false;

    // MSX 가 PSG 를 그만 건드리면 울리던 음을 끊는다.
    //
    // **카트리지는 MSX 전원과 따로 산다.** USB 로 전원을 받으므로 MSX 를 꺼도
    // 계속 돈다. 그 순간 PSG 쓰기만 끊기고 레지스터 그림자는 마지막 값 그대로
    // 남는다 - 울리던 음이 영영 매달린 채 맥에서 계속 난다. 실기에서 그렇게
    // 들렸다 (2026-09-21).
    //
    // 쓰기 수가 멈춘 것으로 알아챈다. MSX 음악 드라이버는 프레임마다(50 Hz)
    // 레지스터를 쓰므로, 1 초가 지나도 한 번도 안 썼으면 그 기계는 소리를
    // 내는 중이 아니다 - 껐거나, 멈췄거나, 리셋 중이다.
    //
    // 되살아나는 데 아무것도 필요 없다. 쓰기가 다시 오면 그 프레임부터 그냥
    // 이어진다 - 여기서 상태를 지우지 않고 소리만 멈추기 때문이다.
    static uint32_t  last_writes;
    static uint64_t  last_write_us;
    static bool      psg_quiet;
    const uint32_t writes_now = psg_write_count;
    if (writes_now != last_writes) {
        last_writes = writes_now;
        last_write_us = now;
        if (psg_quiet)
            psg_quiet = false;          // MSX 가 돌아왔다
    }
    if (!psg_quiet && last_write_us != 0u && (now - last_write_us) > 1000000u) {
        psg_quiet = true;
        if (mounted)
            all_notes_off();            // 매달린 음을 남기지 않는다
    }
    if (psg_quiet)
        return;

    if (mounted && midi_on) {
        // 2 초마다 음색을 다시 주장한다 - midi_reassert 의 주석 참조.
        // 악기가 방금 바뀌었으면 주기를 기다리지 않는다.
        static uint64_t next_reassert;
        if (midi_prog_dirty) {
            midi_prog_dirty = false;
            next_reassert = now;
        }
        if (now >= next_reassert) {
            next_reassert = now + 2000000u;
            midi_reassert();
        }
        frame(s);          // MIDI 는 음원에 맡긴다
    }
}

void pd_midipac_set_program(uint8_t prog)
{
    prog &= 0x7Fu;
    if (prog == midi_prog)
        return;
    midi_prog = prog;
    // **여기서 직접 MIDI 를 보내지 않는다.** 이 함수는 호스트 프레임을 푸는
    // 자리에서 불리고, tud_* 는 core1 에서만 불러야 한다. 플래그만 세우면
    // core1 이 다음 20 ms 틱에 처리한다 - 사람 귀에는 즉시다.
    midi_prog_dirty = true;
}

void pd_midipac_set_enabled(bool on)
{
    if (enabled == on)
        return;
    enabled = on;
    if (!on)
        all_notes_off();            // 끄면서 울리던 음을 남기지 않는다
}

bool     pd_midipac_enabled(void)     { return enabled; }

void pd_midipac_set_stream(bool on) { stream_on = on; }
bool pd_midipac_stream(void)        { return stream_on; }

void pd_midipac_set_midi(bool on)
{
    if (midi_on == on)
        return;
    midi_on = on;
    if (!on)
        all_notes_off();            // 끄면서 울리던 음을 남기지 않는다
}
bool pd_midipac_midi(void)          { return midi_on; }
uint32_t pd_midipac_psg_writes(void)  { return psg_write_count; }
uint32_t pd_midipac_notes_sent(void)  { return notes_sent; }
