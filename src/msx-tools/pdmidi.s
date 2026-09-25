;-----------------------------------------------------------------------------
; PDMIDI.COM - let MSX-MIDI software find an interface on a machine without one.
;
;       A>PDMIDI
;
; Why this exists
;   MSX-MIDI software (MIDRY /I5 and the like) writes MIDI bytes to the 8251 data
;   port 0xE8, and the cartridge already passes those to USB-MIDI. But before it
;   writes anything it reads the 8251 status at 0xE9 and waits for TxRDY. On a
;   machine with no MSX-MIDI - the Sony HB-F1XD, say - nothing drives 0xE9, it
;   floats to 0xFF, and MIDRY gives up with "I/F not found". An OCM answers 0xE9
;   itself, which is why the same software works there.
;
;   This tells the PicoDock firmware to answer 0xE9 reads with 0x05 (TxRDY |
;   TxEMPTY, "ready to send"), the value an OCM gives. Run it once per boot, or
;   put it in AUTOEXEC.BAT.
;
; Why it is safe to run anywhere
;   The firmware only drives 0xE9 after the knock below, and this only knocks
;   when 0xE9 reads 0xFF - nothing there. On a machine with its own MSX-MIDI
;   (turbo R GT, an OCM, an MSX-MIDI cartridge) 0xE9 answers already and this
;   leaves it alone. An MSX-MIDI cartridge can also sit at 0xE0-0xE7 until its
;   software moves it to 0xE8; if 0xE1 answers, this does not knock either.
;
;   Enable - a 4-byte "knock" (F0 E9 0F A5) to unused port 0x2E, which the
;   firmware's I/O write captor watches; on the full sequence it enables the
;   0xE9 read responder (a PD_MIDI_STATUS build, firmware 1.24.1 or later). See
;   src/picoverse-picodock/msx_bus.pio (msx_status_read_responder).
;
; Build: ./src/msx-tools/build.sh   ->  dist/disk/system/PDMIDI.COM
;
; (c) 2026 - part of the msx-serial project
;-----------------------------------------------------------------------------

        .area _CODE

BDOS      = 0x0005
C_WRITE   = 0x02                ; print the character in E
F_STROUT  = 0x09                ; print $-terminated string
F_TERM    = 0x00                ; terminate process

MIDI_STAT = 0xE9                ; MSX-MIDI 8251 status (TxRDY bit0, TxEMPTY bit2)
PARK_STAT = 0xE1                ; the same 8251 before its software moves it to 0xE8
READY     = 0x05                ; what the firmware answers: TxRDY | TxEMPTY

KNOCKPORT = 0x2E                ; unused I/O port the firmware watches for the knock

;-----------------------------------------------------------------------------
; Does anything answer already?
;-----------------------------------------------------------------------------
        in      a,(MIDI_STAT)
        cp      #0xFF
        jr      nz,answered
        in      a,(PARK_STAT)
        cp      #0xFF
        jr      nz,parked

;-----------------------------------------------------------------------------
; Nothing there: knock to enable the 0xE9 responder (interrupts off so the four
; writes go out back-to-back), give the firmware a moment, and read it back.
;-----------------------------------------------------------------------------
        di
        ld      a,#0xF0
        out     (KNOCKPORT),a
        ld      a,#0xE9
        out     (KNOCKPORT),a
        ld      a,#0x0F
        out     (KNOCKPORT),a
        ld      a,#0xA5
        out     (KNOCKPORT),a
        ei
        ld      b,#0                    ; ~1 ms; the firmware needs microseconds
settle: djnz    settle

        in      a,(MIDI_STAT)
        cp      #READY
        jr      z,armed
        cp      #0xFF
        jr      z,silent
        ld      de,#msg_odd             ; something answered, but not our 0x05
        jr      value

answered:
        ld      de,#msg_there
        jr      value

parked:
        ld      de,#msg_parked
        jr      value

armed:
        ld      de,#msg_armed
        jr      report

silent:
        ld      de,#msg_silent
        jr      report

;-----------------------------------------------------------------------------
; value: print DE, then A as two hex digits, then the second line that follows
; the first string's '$'.  report: print DE and quit.
;-----------------------------------------------------------------------------
value:
        push    af
        push    de
        ld      c,#F_STROUT
        call    BDOS
        pop     hl                      ; step past the first string's '$'
        ld      a,#'$'
skip:   cp      (hl)
        inc     hl
        jr      nz,skip
        pop     af
        push    hl
        call    hex
        pop     de

report:
        ld      c,#F_STROUT
        call    BDOS
        ld      c,#F_TERM
        jp      BDOS

hex:
        push    af
        rrca
        rrca
        rrca
        rrca
        call    nibble
        pop     af
nibble:
        and     #0x0F
        add     a,#0x90
        daa
        adc     a,#0x40
        daa
        ld      e,a
        ld      c,#C_WRITE
        jp      BDOS

;-----------------------------------------------------------------------------
msg_there:
        .ascii  "PDMIDI: 0xE9 already reads $"
        .ascii  "."
        .db     0x0D, 0x0A
        .ascii  "MSX-MIDI is there (this machine's own, or PDMIDI already"
        .db     0x0D, 0x0A
        .ascii  "ran). Nothing to do."
        .db     0x0D, 0x0A
        .ascii  "$"

msg_parked:
        .ascii  "PDMIDI: 0xE1 reads $"
        .ascii  " - an MSX-MIDI cartridge may be parked"
        .db     0x0D, 0x0A
        .ascii  "there. Not arming 0xE9; let its own software move it."
        .db     0x0D, 0x0A
        .ascii  "$"

msg_armed:
        .ascii  "PDMIDI: 0xE9 now reads 05 - MSX-MIDI status armed."
        .db     0x0D, 0x0A
        .ascii  "MIDI software (MIDRY /I5 ...) finds the interface, and"
        .db     0x0D, 0x0A
        .ascii  "its MIDI goes out of the cartridge as USB-MIDI."
        .db     0x0D, 0x0A
        .ascii  "$"

msg_silent:
        .ascii  "PDMIDI: 0xE9 still reads FF - the cartridge did not answer."
        .db     0x0D, 0x0A
        .ascii  "Needs PicoDock firmware 1.24.1 or later."
        .db     0x0D, 0x0A
        .ascii  "$"

msg_odd:
        .ascii  "PDMIDI: 0xE9 reads $"
        .ascii  " after arming, not 05. Something else"
        .db     0x0D, 0x0A
        .ascii  "drives the port; do not use MSX-MIDI software here."
        .db     0x0D, 0x0A
        .ascii  "$"
