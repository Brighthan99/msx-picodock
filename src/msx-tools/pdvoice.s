;-----------------------------------------------------------------------------
; PDVOICE.COM - say something out of the MSX's own sound chip
;
;   A>PDVOICE hello there
;   A>PDVOICE /D6 hello there      ; a shorter delay: plays faster
;
; What happens
;   The text goes to the host over the mailbox, exactly the way PDASK sends a
;   question. The host synthesises it (say / espeak-ng / piper - see
;   src/host/pd_voice.py), turns the waveform into one byte a sample, and feeds
;   those bytes into a ring inside the cartridge. This program reads them out
;   one at a time and pours them into the PSG.
;
; Why the PSG can do this at all
;   It is a square-wave chip, not a DAC. But disable a channel's tone in the
;   mixer and its output sits at logic 1, and then **the volume register is the
;   output level**. That is a four-bit DAC - except the volume steps are
;   logarithmic, so four bits of register is nearer two bits of amplitude.
;   Three channels summed reach 808 distinct levels, which is about nine bits,
;   and that is enough for speech. The host picks 256 of those 808 and sends the
;   index; psgvol_table.inc turns the index back into three volumes.
;
; Why page 1 gets switched
;   The sample window is at 0x7F0C, inside the cartridge's Nextor window. Under
;   MSX-DOS page 1 is RAM, so reaching it normally means RDSLT - a BIOS call
;   that costs hundreds of T-states. There are about 300 T-states per sample in
;   total. So for the duration of the word the cartridge is switched into page 1
;   and read directly, with interrupts off.
;
;   Everything the loop touches therefore lives in page 0: this code, the
;   volume tables (copied there at startup), and the stack (switched below).
;   Nothing calls BDOS while the switch is in effect - BDOS would work, but its
;   buffers may be in page 1, and that is not worth finding out the hard way.
;
; Why reading 0x7F0C advances and reading the mailbox does not
;   pd_mailbox.h keeps its reads pure on purpose: a stray slot scan must not eat
;   a byte of a message. Here the opposite is wanted - one read, one sample -
;   so it is a different address rather than a mode. See pd_voice_win.h.
;
; The speed is not set here
;   The loop below is a fixed number of T-states, but a real MSX does not run at
;   its nominal clock: the VDP takes the bus periodically and the Z80 gets about
;   nine tenths of the cycles it looks like it should. So the sample rate that
;   comes out is a property of the machine, not of this file. **The host
;   measures it** - it can see how fast the cartridge's ring drains - and
;   resamples to match. /D is here for trying things, not for tuning.
;
; ESC gives up while waiting for the host. Once the word starts, it plays.
;
; Build: ./src/msx-tools/build.sh
;
; (c) 2026 - part of the msx-serial project
;-----------------------------------------------------------------------------

        .area _CODE

BDOS     = 0x0005
F_TERM   = 0x00
F_DIRIO  = 0x06
F_STROUT = 0x09

RDSLT    = 0x000C               ; A = slot, HL = addr -> A
WRSLT    = 0x0014               ; A = slot, HL = addr, E = byte
EXPTBL   = 0xFCC1

TAIL_LEN = 0x0080
TAIL     = 0x0081

SIG_ADDR = 0x7F00
ST_ADDR  = 0x7F08
TX_ADDR  = 0x7F0A
RX_ADDR  = 0x7F09
ACK_ADDR = 0x7F0B

ST_RX_READY = 0x01
ST_TX_FULL  = 0x02
ST_USB_CONN = 0x04

; The voice window - pd_voice_win.h. Three addresses right after the mailbox.



OP_SPEAK  = 0x04                ; MSX -> host: LO HI then that many text bytes
OP_CANCEL = 0x03
OP_ACK    = 0x06
OP_ERR    = 0x8F                ; host -> MSX: no, and here is why

KEY_ESC  = 0x1B

; djnz iterations of padding per sample. 8 lands near 11 kHz on a machine that
; gives the Z80 about nine tenths of its nominal clock. /D overrides it; the
; host adapts either way, so this is a starting point and not a calibration.
DELAY_DEFAULT = 8

;=============================================================================
; The words to say are the command tail.
;=============================================================================
        ld      (saved_sp),sp           ; quit 가 되돌린다. 이 프로그램은 SP 를
                                        ; 바꾸지 않지만, 되돌려 두면 나중에
                                        ; 누가 바꿔도 나가는 길은 온전하다.

        ld      a,(TAIL_LEN)
        or      a
        jr      nz,have_tail
usage:
        ld      hl,#msg_usage
        call    puts
        jp      quit

have_tail:
        ld      hl,#TAIL
        ld      b,a
skip_sp:
        ld      a,(hl)
        cp      #0x20
        jr      nz,check_opt
        inc     hl
        djnz    skip_sp
        jr      usage

;-----------------------------------------------------------------------------
; /Dn - how much padding per sample. One digit; anything else is text.
;-----------------------------------------------------------------------------
check_opt:
        cp      #0x2F                   ; '/'
        jr      nz,got_text
        ld      a,b
        cp      #2                      ; "/x" at the very least
        jr      c,got_text
        inc     hl
        ld      a,(hl)
        and     #0xDF                   ; upper case
        cp      #0x54                   ; 'T' - self-test, nothing else needed
        jr      z,self_test
        cp      #0x53                   ; 'S' - a pure tone through one table
        jr      z,opt_tone
        cp      #0x56                   ; 'V' - show what the Z80 latched
        jr      z,opt_verbose
        cp      #0x44                   ; 'D' - padding per sample
        jr      nz,back_up
        ; **"/D" needs a digit after it.** The length check used to live above,
        ; where it also demanded three characters for "/T" - and so the
        ; self-test could never be reached, because "/T" is two.
        ld      a,b
        cp      #3
        jr      c,back_up
        inc     hl
        ld      a,(hl)
        sub     #0x30
        cp      #10
        jr      nc,back_up2
        ld      (pd_delay_n),a
        inc     hl
        dec     b
        dec     b
        dec     b
        jr      skip_sp

opt_tone:
        ; **순음이라야 곡선을 가를 수 있다.** 말은 원래 배음투성이라 왜곡이
        ; 더해져도 "원래 그런가" 가 된다. 사인파에는 그 변명이 없다: 표가
        ; 맞으면 맑은 음 하나, 휘었으면 갈대처럼 쐐한 음이다.
        ld      a,b
        cp      #3
        jr      c,back_up               ; "/Sn" 이라야 한다
        inc     hl
        ld      a,(hl)
        sub     #0x31                   ; '1' -> 0
        cp      #PSGVOL_COUNT
        jr      nc,back_up2
        ld      (pd_which),a
        jp      tone_test

opt_verbose:
        ld      a,#1
        ld      (verbose),a
        inc     hl
        dec     b
        dec     b
        jr      skip_sp

back_up2:
        dec     hl
back_up:
        dec     hl
got_text:
        ld      (text),hl
        ld      a,b
        ld      (text_len),a
        or      a
        jr      z,usage
        ; **Jump, do not fall through.** The self-test sits between here and the
        ; slot scan, and without this every run walked into it - options and all.
        ; A block dropped into a fall-through path does not announce itself.
        jp      find_cart

;=============================================================================
; /T - is the chip making any sound at all?
;
; **Nothing here touches the cartridge or the host.** It lays out the same
; tables the player uses, puts the PSG in DAC mode the same way, and then walks
; the table from silence to full and back, about 200 times a second. That is a
; buzz, and it is loud.
;
; Why it exists: the first run played 12358 samples at a measured 10470 Hz -
; every part of the path worked - and made no sound. When everything reports
; success and nothing comes out, the useful move is to cut the path in half.
; If this buzzes, the table and the chip and the DAC mode are all fine and the
; fault is in the streaming loop. If it is silent, the fault is here, and no
; amount of looking at the ring will find it.
;=============================================================================
self_test:
        call    pd_play_init
        call    patch_diag
        ld      hl,#msg_testing
        call    puts
        di
        call    pd_dac_on
        ld      d,#60                   ; how many sweeps - about a second
st_sweep:
        ld      e,#0                    ; the sample byte, 0 -> 255
st_step:
        ld      a,e
        ld      l,a
tpatch_a:
        ld      h,#0
        ld      a,#8
        out     (PSG_ADDR),a
        ld      a,(hl)
        out     (PSG_DATA),a
tpatch_b:
        ld      h,#0
        ld      a,#9
        out     (PSG_ADDR),a
        ld      a,(hl)
        out     (PSG_DATA),a
tpatch_c:
        ld      h,#0
        ld      a,#10
        out     (PSG_ADDR),a
        ld      a,(hl)
        out     (PSG_DATA),a
        ld      b,#8
st_pad: djnz    st_pad
        inc     e
        jr      nz,st_step
        dec     d
        jr      nz,st_sweep
        call    pd_dac_off
        ei
        ld      hl,#msg_tested
        call    puts
        jp      quit

;=============================================================================
; /Sn - one pure tone, through table n. No host, no cartridge window.
;
; The tone is a sine written as table *indices*. Play those indices through a
; volume table and what comes out is a sine only if that table's curve matches
; the chip. Get the curve wrong and the path from index to level is bent, and
; a bent path fills a sine with harmonics - a reed rather than a flute.
;
; That is the whole reason there are three tables in here. The machine is the
; only thing that can say which of them is its own.
;=============================================================================
tone_test:
        call    pd_play_init
        call    patch_diag
        ld      hl,#msg_tone
        call    puts
        ld      a,(pd_which)
        add     a,#0x31
        ld      e,a
        ld      c,#0x02
        call    BDOS
        call    crlf

        di
        call    pd_dac_on
        ld      d,#160                  ; cycles of the wave - about 1.5s
tt_cycle:
        ld      hl,#sine24
        ld      b,#24
tt_step:
        ld      a,(hl)
        push    hl
        ld      l,a
spatch_a:
        ld      h,#0
        ld      a,#8
        out     (PSG_ADDR),a
        ld      a,(hl)
        out     (PSG_DATA),a
spatch_b:
        ld      h,#0
        ld      a,#9
        out     (PSG_ADDR),a
        ld      a,(hl)
        out     (PSG_DATA),a
spatch_c:
        ld      h,#0
        ld      a,#10
        out     (PSG_ADDR),a
        ld      a,(hl)
        out     (PSG_DATA),a
        pop     hl
        inc     hl
        push    bc
        ld      b,#6
tt_pad: djnz    tt_pad
        pop     bc
        djnz    tt_step
        dec     d
        jr      nz,tt_cycle
        call    pd_dac_off
        ei
        ld      hl,#msg_toned
        call    puts
        jp      quit

;=============================================================================
; Find the cartridge. Same scan as PDASK: whichever slot answers "PDSERIAL".
;=============================================================================
find_cart:
        ld      b,#0
prim_loop:
        ld      hl,#EXPTBL
        ld      a,b
        add     a,l
        ld      l,a
        ld      a,(hl)
        and     #0x80
        jr      z,try_plain

        ld      c,#0
sub_loop:
        ld      a,c
        rlca
        rlca
        and     #0x0C
        or      b
        or      #0x80
        call    check_slot
        jr      nz,found
        inc     c
        ld      a,c
        cp      #4
        jr      c,sub_loop
        jr      next_prim

try_plain:
        ld      a,b
        call    check_slot
        jr      nz,found

next_prim:
        inc     b
        ld      a,b
        cp      #4
        jr      c,prim_loop

        ld      hl,#msg_notfound
        call    puts
        jp      quit

found:
        call    mb_status
        and     #ST_USB_CONN
        jr      nz,send_text
        ld      hl,#msg_nohost
        call    puts
        jp      quit

;=============================================================================
; Ask for it: 04 LO HI then the text.
;=============================================================================
send_text:
        ld      e,#OP_SPEAK
        call    mb_send
        ld      a,(text_len)
        ld      e,a
        call    mb_send
        ld      e,#0                    ; a DOS tail cannot reach 256 bytes
        call    mb_send

        ld      a,(text_len)
        ld      b,a
        ld      hl,(text)
tx_loop:
        ld      e,(hl)
        push    hl
        push    bc
        call    mb_send
        pop     bc
        pop     hl
        inc     hl
        djnz    tx_loop

        ld      hl,#msg_asked
        call    puts

        call    pd_play_init

        call    patch_diag

;=============================================================================
; Wait for the first samples. Synthesis takes a moment, and the host may say no.
;=============================================================================
wait_ring:
        call    mb_status
        and     #ST_RX_READY
        jr      nz,host_spoke          ; the only thing that comes back on this
                                       ; channel is a refusal

        ld      a,(pd_slot)
        ld      hl,#V_STAT
        push    hl
        call    RDSLT
        pop     hl
        and     #V_READY
        jr      nz,play

        ld      c,#F_DIRIO
        ld      e,#0xFF
        call    BDOS
        cp      #KEY_ESC
        jr      nz,wait_ring

        ld      e,#OP_CANCEL
        call    mb_send
        ld      hl,#msg_cancel
        call    puts
        jp      quit

host_spoke:
        ; **push af / pop bc does not move A into C.** It puts A in B and the
        ; flags in C, and puthex prints C - so every refusal printed the flags
        ; register. "Code AF" was the Z80's mood, not the host's answer.
        call    mb_get                  ; 8F, which we already know
        call    mb_get                  ; the code
        ld      c,a
        ld      hl,#msg_refused
        call    puts
        call    puthex
        call    crlf
        jp      quit

;=============================================================================
; Play it.
;
; From here to `restored` the cartridge is in page 1 and interrupts are off.
; Nothing in here may call BDOS, and nothing may touch anything in 0x4000-0x7FFF
; except the three voice addresses.
;=============================================================================
play:
        call    pd_play
        jr      nc,played_ok
        ld      hl,#msg_badstack
        call    puts
        jp      quit
played_ok:
        ld      (ended_flags),a

        ld      a,(verbose)
        or      a
        jr      z,no_dump
        ld      hl,#msg_first
        call    puts
        ld      hl,#first8
        ld      b,#8
dump_loop:
        ld      c,(hl)
        push    hl
        push    bc
        call    puthex
        ld      e,#0x20
        ld      c,#0x02
        call    BDOS
        pop     bc
        pop     hl
        inc     hl
        djnz    dump_loop
        call    crlf
no_dump:

        ld      a,(ended_flags)
        and     #V_UNDERRUN
        jr      z,played_clean
        ld      hl,#msg_gaps
        call    puts
        jp      quit
played_clean:
        ld      hl,#msg_done
        call    puts
        jp      quit

; 진단 루프 둘(/T 와 /Sn)이 쓰는 ld h,#n 을 채운다. pd_play_init 이 제 것만
; 고치는 이유는 남의 라벨을 만지는 루틴은 아무도 못 옮기기 때문이다 -
; 여기서 우리 것을 우리가 고친다.
patch_diag:
        ld      a,(pd_play_planes + 0)
        ld      (tpatch_a + 1),a
        ld      (spatch_a + 1),a
        ld      a,(pd_play_planes + 1)
        ld      (tpatch_b + 1),a
        ld      (spatch_b + 1),a
        ld      a,(pd_play_planes + 2)
        ld      (tpatch_c + 1),a
        ld      (spatch_c + 1),a
        ret

;=============================================================================
; check_slot - does the slot in A hold the signature at 0x7F00?
;
; NZ when it matches, and the slot is left in `slot`. The answer is not a Z from
; a compare because slot 0 is a legal slot and every "set the flags from A"
; trick would call it a mismatch.
;=============================================================================
check_slot:
        push    bc
        ld      (pd_slot),a
        ld      de,#sig
        ld      hl,#SIG_ADDR
        ld      b,#8
cs_loop:
        push    bc
        push    de
        push    hl
        ld      a,(pd_slot)
        call    RDSLT
        pop     hl
        pop     de
        ld      c,a
        ld      a,(de)
        cp      c
        pop     bc
        jr      nz,cs_fail
        inc     hl
        inc     de
        djnz    cs_loop
        pop     bc
        ld      a,#1
        or      a
        ret
cs_fail:
        pop     bc
        xor     a
        ret

;=============================================================================
; The mailbox, through RDSLT/WRSLT. Slow, and it does not matter: none of this
; happens while a word is playing.
;=============================================================================
mb_status:
        push    bc
        push    de
        push    hl
        ld      a,(pd_slot)
        ld      hl,#ST_ADDR
        call    RDSLT
        pop     hl
        pop     de
        pop     bc
        ret

mb_send:
        push    bc
        push    de
        push    hl
        ld      bc,#0                   ; 65536 tries, then give the byte up
tx_wait:
        call    mb_status
        and     #ST_TX_FULL
        jr      z,tx_go
        dec     bc
        ld      a,b
        or      c
        jr      nz,tx_wait
        jr      tx_out
tx_go:
        pop     hl
        pop     de
        push    de
        push    hl
        ld      hl,#TX_ADDR
        ld      a,(pd_slot)
        call    WRSLT
tx_out:
        pop     hl
        pop     de
        pop     bc
        ret

;-----------------------------------------------------------------------------
; mb_get - the next byte from the host in A. Only ever called once the status
; says one is there, so it does not wait.
;-----------------------------------------------------------------------------
mb_get:
        push    bc
        push    de
        push    hl
        ld      a,(pd_slot)
        ld      hl,#RX_ADDR
        call    RDSLT
        ld      (rx_byte),a
        ld      a,(pd_slot)
        ld      hl,#ACK_ADDR
        ld      e,#1
        call    WRSLT                   ; reads are pure - this is what advances
        pop     hl
        pop     de
        pop     bc
        ld      a,(rx_byte)
        ret

;=============================================================================
; Console
;=============================================================================
puts:
        push    bc
        push    de
        ex      de,hl
        ld      c,#F_STROUT
        call    BDOS
        pop     de
        pop     bc
        ret

crlf:
        ld      hl,#msg_crlf
        jp      puts

;-----------------------------------------------------------------------------
; puthex - C as two hex digits
;-----------------------------------------------------------------------------
puthex:
        ld      a,c
        rrca
        rrca
        rrca
        rrca
        call    puthex1
        ld      a,c
puthex1:
        and     #0x0F
        add     a,#0x30
        cp      #0x3A
        jr      c,puthex2
        add     a,#7
puthex2:
        push    bc
        ld      e,a
        ld      c,#0x02
        call    BDOS
        pop     bc
        ret

quit:
        ld      sp,(saved_sp)
        ld      c,#F_TERM
        jp      BDOS

;=============================================================================
; Data
;=============================================================================
; How long to hold on while the host is behind, in samples. About two seconds
; at 11 kHz. Long enough to ride out a disk read on the same USB pipe, short
; enough that a host which has died does not leave the machine locked up with
; interrupts off - which needs the reset button, because ESC cannot be read
; from in there.
STALL_LIMIT = 22000

sig:            .ascii  "PDSERIAL"
msg_usage:      .ascii  "PDVOICE - say something through the PSG"
                .db     13,10
                .ascii  "  PDVOICE hello there"
                .db     13,10
                .ascii  "  PDVOICE /D6 hello    (shorter pad, plays faster)"
                .db     13,10
                .ascii  "  PDVOICE /T           (self-test: no host, just a buzz)"
                .db     13,10
                .ascii  "  PDVOICE /V hello     (show the bytes the Z80 latched)"
                .db     13,10
                .ascii  "  PDVOICE /S1          (pure tone; /S2 /S3 other curves)"
                .db     13,10,'$'
msg_notfound:   .ascii  "No PicoDock found."
                .db     13,10,'$'
msg_nohost:     .ascii  "The cartridge is here but the host is not."
                .db     13,10,'$'
msg_asked:      .ascii  "Synthesising..."
                .db     13,10,'$'
msg_cancel:     .ascii  "Cancelled."
                .db     13,10,'$'
msg_refused:    .ascii  "The host will not say it. Code "
                .db     '$'
msg_done:       .ascii  "Spoken."
                .db     13,10,'$'
msg_gaps:       .ascii  "Spoken, with gaps - the host fell behind."
                .db     13,10,'$'
msg_tone:       .ascii  "A pure tone through table "
                .db     '$'
msg_toned:      .ascii  "Done. A clean tone means this table's curve is the"
                .db     13,10
                .ascii  "chip's. A reedy one means it is not."
                .db     13,10,'$'
msg_testing:    .ascii  "Self-test: a buzz for about a second."
                .db     13,10,'$'
msg_tested:     .ascii  "Done. If you heard nothing, the chip is not making"
                .db     13,10
                .ascii  "sound from the volume registers on this machine."
                .db     13,10,'$'
msg_badstack:   .ascii  "The stack is in page 1 - cannot switch the cartridge in."
                .db     13,10,'$'
msg_first:      .ascii  "First samples read: "
                .db     '$'
msg_crlf:       .db     13,10,'$'

; One cycle of a sine as table indices, 24 samples. At about 10.5 kHz that is
; some 436 Hz - middle of where the ear is fussiest, and 24 samples a cycle is
; enough that the steps themselves are not what you hear.
sine24:
        .db     128,159,188,213,232,244,248,244,232,213,188,159,128,97,68,43,24,12,8,12,24,43,68,97

; 기본으로 쓸 볼륨 표. **호스트가 고른 것과 같아야 한다** - 이 값은
; psgvol_table.inc 가 pd_voice.py 의 DEFAULT_CURVE 에서 만들어 준다. 손으로
; 맞추면 언젠가 어긋나고, 어긋난 표는 뻗지 않고 그냥 쐐한 소리를 낸다.
first8:         .ds     8               ; what the Z80 actually latched
verbose:        .db     0
rx_byte:        .db     0
ended_flags:    .db     0
text:           .dw     0
text_len:       .db     0
saved_sp:       .dw     0

; **이 셋이 마지막이고, 뒤에 아무것도 오지 않는다.** 표는 prog_end 다음 첫
; 페이지 경계로 옮겨지므로, 뒤에 무엇을 두면 pd_play_init 이 도는 순간 덮인다.
        .include "pdplay.inc"
        .include "psgvol_table.inc"
prog_end:
