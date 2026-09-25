;-----------------------------------------------------------------------------
; pdplay.inc - play what the cartridge's voice ring is holding.
;
; Shared by PDVOICE (which asks for a sentence and plays it) and PDASK (which
; asks a question and plays the answer). **One copy, not two.** The loop below
; is 305 T-states a sample and every instruction in it was placed by
; measurement; a second copy would drift, and the drift would not crash - it
; would just sound worse on one of the two tools, which is the kind of fault
; this project has already spent days on.
;
; What the caller provides
;   pd_slot        the cartridge's slot byte (the PDSERIAL scan found it)
;   prog_end       comes from here - this file is included LAST
;
; What the caller gets
;   pd_play_init   lay the volume tables on page boundaries. Call once.
;   pd_wait_ready  wait for the first sample to arrive. **Call this first.**
;   pd_play        play the cartridge's ring until it ends or nobody feeds it.
;
; 한때 셋이 있었다: 링(이것), 디스크의 파일, 메일박스. 실기에서 셋 다 들어보고
; 링만 남겼다 - **소리가 셋 다 같았고**, 그것이 남은 잡음이 버스가 아니라 볼륨
; 표라는 뜻이라 더 팔 이유가 없어졌다. 나머지는 느리거나(메일박스는 한 마디에
; 10 초) 길이에 갇혔다. node/src/voices.js 에 그 이야기가 있고, 코드는 git 에
; 있다 (v1.18.3).
;                  Cy set = refused (the stack is in page 1).
;                  Otherwise A = the window's last status: bit2 means there
;                  were gaps.
;   pd_play_planes three bytes: the page each channel's table sits on. A caller
;                  with its own copy of the loop (PDVOICE's diagnostics) patches
;                  itself from these rather than having this file reach into it.
;
; Why the MSX has to be the one playing
;   The host can put samples in the ring but cannot take them out. Nothing
;   drains it unless a Z80 loop reads 0x7F0C, so a tool that streams without
;   running this ends up with a full ring, a host that waits for room for ever,
;   and silence. PDASK did exactly that for one release.
;-----------------------------------------------------------------------------

; --- the voice window (pd_voice_win.h) --------------------------------------
V_DATA   = 0x7F0C               ; R, reading takes a sample
V_STAT   = 0x7F0D               ; R, no side effect
V_CTRL   = 0x7F0E               ; W, 1 = start, 0 = stop and drop

V_READY    = 0x01
V_ENDED    = 0x02
V_UNDERRUN = 0x04

PSG_ADDR = 0xA0                 ; which register
PSG_DATA = 0xA1                 ; the value

PD_ENASLT = 0x0024              ; A = slot, H = any address in the page
PD_RAMAD1 = 0xF342              ; the slot page 1 normally holds under DOS

; djnz iterations of padding per sample. 8 lands near 11 kHz on a machine that
; gives the Z80 about nine tenths of its nominal clock. The host measures what
; actually comes out and synthesises the next sentence to match, so this is a
; starting point and not a calibration.
PD_DELAY_DEFAULT = 8


; How long to hold on while the host is behind, in samples. About two seconds
; at 11 kHz. Long enough to ride out a disk read on the same USB pipe, short
; enough that a host which has died does not leave the machine locked up with
; interrupts off - which needs the reset button, because the loop runs with
; them disabled and ESC cannot be read from in there.
PD_STALL_LIMIT = 22000

PD_BDOS   = 0x0005
PD_DIRIO  = 0x06                ; E=FF: a key without echo, 0 if none
PD_RDSLT  = 0x000C
PD_KEY_ESC = 0x1B

;=============================================================================
; pd_wait_ready - wait until there is something to play.
;
; **"Sound is coming" is not "sound is here".** The host says it will send an
; utterance before it has finished making one, and making one takes a second or
; six - a 500-character answer measured six. Arming the ring before the first
; sample arrives means the loop starts, finds nothing, holds the last level
; (which is a faint hum, not silence) and gives up two seconds later. That is
; exactly what a real run did, with the stream arriving four seconds after the
; player had already stopped.
;
; So poll until READY. ESC gives up; synthesis that has not arrived in half a
; minute is not arriving.
;
; out: Cy set = gave up or cancelled.
;=============================================================================
; **Generous on purpose.** One pass is 65536 polls and each poll is an
; inter-slot read plus a BDOS call, so a pass is some seconds - but how many
; depends on the machine, and counting polls is not counting time. Synthesis of
; a 500-character answer measured six seconds, so a budget that might be five
; is a budget that sometimes gives up on a sentence that was coming. Eight
; passes is far more than needed and costs nothing: ESC gets out at any point.
PD_WAIT_PASSES = 8

pd_wait_ready:
        ld      d,#PD_WAIT_PASSES
pd_wr_pass:
        ld      bc,#0                   ; 65536
pd_wr_loop:
        push    de
        push    bc
        ld      a,(pd_slot)
        ld      hl,#V_STAT
        call    PD_RDSLT
        pop     bc
        pop     de
        and     #V_READY
        jr      nz,pd_wr_got

        push    de
        push    bc
        ld      c,#PD_DIRIO
        ld      e,#0xFF
        call    PD_BDOS
        pop     bc
        pop     de
        cp      #PD_KEY_ESC
        jr      z,pd_wr_gave_up

        dec     bc
        ld      a,b
        or      c
        jr      nz,pd_wr_loop
        dec     d
        jr      nz,pd_wr_pass
pd_wr_gave_up:
        scf
        ret
pd_wr_got:
        or      a                       ; Cy = 0
        ret

;=============================================================================
; pd_play - the whole word.
;=============================================================================
pd_play:
        ; **The stack stays where DOS put it.** Moving it into page 0 is wrong
        ; twice over: the inter-slot hooks switch page 0 to the BIOS ROM while
        ; they work, so a stack there is read back out of ROM; and DOS's own
        ; stack sits at the top of the TPA, which is page 3 and is never
        ; switched. The only thing to check is that it is not in the page about
        ; to be taken away.
        ld      hl,#0
        add     hl,sp
        ld      a,h
        and     #0xC0
        cp      #0x40
        jr      nz,pd_stack_ok
        scf                             ; Cy = refused
        ret
pd_stack_ok:
        di

        ld      a,(pd_slot)
        ld      h,#0x40                 ; page 1
        call    PD_ENASLT

        call    pd_dac_on

        ld      a,#1
        ld      (V_CTRL),a              ; start: the ring begins handing out

        ld      de,#PD_STALL_LIMIT
pd_loop:
        ld      a,(V_STAT)              ; 13   pure read, no sample taken
        and     #(V_READY | V_ENDED)    ;  7
        dec     a                       ;  4   READY alone -> 0
        jr      nz,pd_not_playing       ;  7   (12 when it branches)

        ld      de,#PD_STALL_LIMIT      ; 10   a sample arrived: full budget
pd_sample:
        ld      a,(V_DATA)              ; 13   **this read takes the sample**
        ld      l,a                     ;  4   the byte is the table offset
pd_patch_a:
        ld      h,#0                    ;  7   <- patched: channel A's plane
        ld      a,#8                    ;  7   PSG register 8 = channel A volume
        out     (PSG_ADDR),a            ; 11
        ld      a,(hl)                  ;  7
        out     (PSG_DATA),a            ; 11
pd_patch_b:
        ld      h,#0                    ;  7   L untouched - the same sample
        ld      a,#9                    ;  7
        out     (PSG_ADDR),a            ; 11
        ld      a,(hl)                  ;  7
        out     (PSG_DATA),a            ; 11
pd_patch_c:
        ld      h,#0                    ;  7
        ld      a,#10                   ;  7
        out     (PSG_ADDR),a            ; 11
        ld      a,(hl)                  ;  7
        out     (PSG_DATA),a            ; 11

pd_delay_ins:
        ld      b,#PD_DELAY_DEFAULT     ;  7   /D patches the byte after this
pd_delay_n  = pd_delay_ins + 1          ;      ...and this is where it is
pd_pad:
        djnz    pd_pad                  ; 13 each, 8 on the last
        jr      pd_loop                 ; 12

;-----------------------------------------------------------------------------
; Not simply playing: either the host fell behind or the word is over.
;
; A = (status & 3) - 1, so 0xFF means nothing is waiting and 1 means ended.
;
; **A gap still gets a sample.** The window hands back the last level it gave
; out rather than zero, because this is a DAC and zero is the bottom of the
; swing - dropping to it would be a click, which is louder than the pause. So
; the stall path goes back through the loop body, and the only thing it costs
; is the budget.
;-----------------------------------------------------------------------------
pd_not_playing:
        inc     a                       ; 0xFF -> 0
        jr      nz,pd_done              ; anything else: ended
        dec     de
        ld      a,d
        or      e
        jr      nz,pd_sample            ; hold the level and keep the pitch
pd_done:
        ld      a,(V_STAT)
        ld      (pd_last_stat),a        ; read it before the window goes away

        xor     a
        ld      (V_CTRL),a              ; stop, and drop anything still queued

        call    pd_dac_off

        ld      a,(PD_RAMAD1)           ; put page 1 back the way DOS had it
        ld      h,#0x40
        call    PD_ENASLT
        ei
        ld      a,(pd_last_stat)
        or      a                       ; Cy = 0: it played
        ret

;=============================================================================
; PSG as a DAC
;
; Tone periods to zero and the mixer's tone bits set (1 = off). With the tone
; generator out of the way the channel output holds at logic 1 and the
; amplitude register alone decides the level.
;
; Mixer bit 7 must stay 1 and bit 6 must stay 0: those are the joystick port
; directions on an MSX, not sound. Getting them wrong does not change the
; noise, it changes whether the keyboard and joystick work.
;=============================================================================
pd_dac_on:
        ld      hl,#pd_dac_regs
        ld      c,#0
        ld      b,#8
pd_dac_loop:
        ld      a,c
        out     (PSG_ADDR),a
        ld      a,(hl)
        out     (PSG_DATA),a
        inc     hl
        inc     c
        djnz    pd_dac_loop
        ret

pd_dac_regs:
        .db     0x00, 0x00              ; R0/R1  channel A period = 0
        .db     0x00, 0x00              ; R2/R3  channel B
        .db     0x00, 0x00              ; R4/R5  channel C
        .db     0x00                    ; R6     noise period
        .db     0xBF                    ; R7     tone off x3, noise off x3

;-----------------------------------------------------------------------------
; Back to silence. **Not optional**: the last sample is left sitting in the
; volume registers, and a held level on a DAC is a tone that does not stop.
;-----------------------------------------------------------------------------
pd_dac_off:
        ld      c,#8                    ; R8/R9/R10 - the three volumes
        ld      b,#3
pd_off_loop:
        ld      a,c
        out     (PSG_ADDR),a
        xor     a
        out     (PSG_DATA),a
        inc     c
        djnz    pd_off_loop
        ret

;=============================================================================
; pd_play_init - lay the volume tables out on page boundaries.
;
; The loop finds a channel's volume with the sample byte in L and the table's
; page in H, so each of the three must start at xx00. sdasz80 has no align that
; survives the .COM link, so the three planes are copied up to the next page
; boundary after the program and the `ld h,#nn` above are patched.
;
; **Patching beats a fixed address**: a fixed one drifts silently when the code
; grows past it, and the failure is not a crash but a voice made of gravel.
;
; A caller with its own copy of the loop reads pd_play_planes instead of having
; this routine reach into it - a routine that patches labels it does not own is
; a routine nobody can move.
;=============================================================================
pd_play_init:
        ; Which curve's table. pd_which holds 0..PSGVOL_COUNT-1.
        ld      a,(pd_which)
        ld      hl,#PSGVOL_SRC1
        or      a
        jr      z,pdi_src
        ld      de,#768
pdi_next:
        add     hl,de
        dec     a
        jr      nz,pdi_next
pdi_src:
        ld      (pdi_from + 1),hl

        ld      hl,#prog_end
        ld      a,l
        or      a
        jr      z,pdi_aligned
        ld      l,#0
        inc     h                       ; round up to the next page
pdi_aligned:
        ld      a,h
        ld      (pd_patch_a + 1),a
        ld      (pd_play_planes + 0),a
        inc     a
        ld      (pd_patch_b + 1),a
        ld      (pd_play_planes + 1),a
        inc     a
        ld      (pd_patch_c + 1),a
        ld      (pd_play_planes + 2),a

        ex      de,hl                   ; DE = the tables' page
pdi_from:
        ld      hl,#PSGVOL_SRC1         ; <- patched above
        ld      bc,#768
        ldir

        ret

;=============================================================================
; Data
;=============================================================================
pd_slot:        .db     0       ; the caller's slot scan fills this
pd_which:       .db     PSGVOL_DEFAULT  ; which curve's table (see the .inc)
pd_last_stat:   .db     0
pd_play_planes: .ds     3

; The caller finishes with, in this order and nothing after them:
;
;         .include "pdplay.inc"
;         .include "psgvol_table.inc"
; prog_end:
;
; sdasz80 will not nest includes, so this file cannot pull the tables in
; itself. And prog_end has to be the real end: the tables are copied to the
; first page boundary past it, so anything placed after would be overwritten
; the moment pd_play_init runs.
