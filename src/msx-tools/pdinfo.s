;-----------------------------------------------------------------------------
; PDINFO.COM - tell the host what this MSX is
;
;   A>PDINFO
;
; The host cannot see any of this by itself. It answers sector reads and
; collects printed bytes; nothing in the frame protocol carries a word about the
; machine the cartridge is plugged into. So the MSX says so, when asked to.
;
; Run it by hand. It is a snapshot, not a service: nothing here stays resident,
; and the host keeps what it was told until it is told again.
;
; What it reads
; -------------
;   BIOS 002Dh   MSX generation: 0 MSX1, 1 MSX2, 2 MSX2+, 3 turbo R
;   BIOS 002Bh   character set, date format, 50/60Hz
;   BIOS 002Ch   keyboard type, BASIC version
;   BDOS 6Fh     MSX-DOS kernel version, and MSXDOS2.SYS / Nextor version
;   RAM  0006h   the BDOS entry point, which is the top of the TPA
;   the scan     which slot the cartridge answered from
;
; Under MSX-DOS page 0 is RAM, not the BIOS - so the three BIOS bytes are read
; with an inter-slot access through EXPTBL, not by loading from 002Dh, which
; would read whatever DOS has at that address.
;
; What it sends
; -------------
;   02 LEN <10 bytes>       on the mailbox, one way, no answer expected
;
; The bytes go out **as they were read**. Nothing here decides that 002Dh=2
; means "MSX2+": that is the host's job, where the wording is a line of Python
; rather than a table of strings in a .COM. This half stays small and hard to
; get wrong, and a better description later costs no MSX-side change at all.
;
; Build: ./src/msx-tools/build.sh
;
; (c) 2026 - part of the msx-serial project
;-----------------------------------------------------------------------------

        .area _CODE

BDOS     = 0x0005
F_TERM   = 0x00
F_CONOUT = 0x02
F_STROUT = 0x09
F_DOSVER = 0x6F                 ; -> A=err, B.C kernel, D.E MSXDOS2.SYS/Nextor

RDSLT    = 0x000C               ; A = slot, HL = addr -> A = byte
WRSLT    = 0x0014               ; A = slot, HL = addr, E = byte
EXPTBL   = 0xFCC1               ; [0] = the main BIOS ROM's slot
BDOS_ENT = 0x0006               ; word: BDOS entry = top of the TPA

SIG_ADDR = 0x7F00
ST_ADDR  = 0x7F08
TX_ADDR  = 0x7F0A

ST_TX_FULL  = 0x02
ST_USB_CONN = 0x04

MSXVER   = 0x002D               ; in the BIOS, reached through EXPTBL
MSXREG   = 0x002B
MSXKBD   = 0x002C

OP_INFO  = 0x02                 ; MSX -> host: LEN then that many bytes
REC_LEN  = 10

;=============================================================================
; Find the cartridge.
; Slot byte for RDSLT:  bit7 = expanded, bits 3-2 = subslot, bits 1-0 = primary
;=============================================================================
        ld      b,#0                    ; B = primary slot
prim_loop:
        ld      hl,#EXPTBL
        ld      a,b
        add     a,l
        ld      l,a
        ld      a,(hl)
        and     #0x80
        jr      z,try_plain

        ld      c,#0                    ; expanded: walk subslots 0-3
sub_loop:
        ld      a,c
        rlca
        rlca                            ; subslot -> bits 3-2
        and     #0x0C
        or      b
        or      #0x80                   ; expanded marker
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
        jr      nz,collect
        ld      hl,#msg_nohost
        call    puts
        jp      quit

;=============================================================================
; Collect. The three BIOS bytes first, while nothing else has touched BC/DE.
;=============================================================================
collect:
        ld      a,(#EXPTBL)             ; the main BIOS ROM's slot
        ld      (bios_slot),a

        ld      hl,#MSXVER
        call    read_bios
        ld      (rec + 0),a
        ld      hl,#MSXREG
        call    read_bios
        ld      (rec + 1),a
        ld      hl,#MSXKBD
        call    read_bios
        ld      (rec + 2),a

        ; DOS and Nextor versions. On a kernel that does not know 6Fh the call
        ; comes back with A != 0, and zeros are the honest answer.
        ld      c,#F_DOSVER
        call    BDOS
        or      a
        jr      z,ver_ok
        ld      bc,#0
        ld      de,#0
ver_ok:
        ld      a,b
        ld      (rec + 3),a
        ld      a,c
        ld      (rec + 4),a
        ld      a,d
        ld      (rec + 5),a
        ld      a,e
        ld      (rec + 6),a

        ld      hl,(BDOS_ENT)           ; top of the TPA
        ld      a,l
        ld      (rec + 7),a
        ld      a,h
        ld      (rec + 8),a

        ld      a,(slot)                ; where the cartridge answered from
        ld      (rec + 9),a

;=============================================================================
; Send: 02 LEN <record>, and show it here as well - the two hex lines are what
; makes a wrong value on the host traceable to the MSX rather than to the parse.
;=============================================================================
        ld      e,#OP_INFO
        call    mb_send
        ld      e,#REC_LEN
        call    mb_send

        ld      hl,#msg_sent
        call    puts

        ld      hl,#rec
        ld      b,#REC_LEN
send_loop:
        ld      e,(hl)
        push    hl
        push    bc
        ld      a,e
        call    puthex                  ; ...and on screen
        ld      a,#0x20
        call    putchar
        pop     bc
        pop     hl
        push    hl
        push    bc
        call    mb_send
        pop     bc
        pop     hl
        inc     hl
        djnz    send_loop

        call    crlf
        ld      hl,#msg_done
        call    puts

quit:
        ld      c,#F_TERM
        jp      BDOS

;=============================================================================
; read_bios - HL = address in the main BIOS ROM -> A
;
; Page 0 belongs to MSX-DOS here, so this cannot be a plain LD A,(nn): that
; would read the DOS kernel's own low memory and report nonsense.
;=============================================================================
read_bios:
        push    bc
        push    de
        push    hl
        ld      a,(bios_slot)
        call    RDSLT                   ; modifies BC/DE
        pop     hl
        pop     de
        pop     bc
        ret

;=============================================================================
; check_slot - does the slot in A hold the signature at 0x7F00?
;
; Returns NZ when it matches, and stores the slot in `slot`. The result is not
; returned in the Z flag from a compare, because slot 0 is a legal slot number
; and every "set the flags from A" trick would report it as a mismatch.
;=============================================================================
check_slot:
        push    bc
        ld      (slot),a
        ld      de,#sig
        ld      hl,#SIG_ADDR
        ld      b,#8
cs_loop:
        push    bc
        push    de
        push    hl
        ld      a,(slot)
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
        ld      a,#1                    ; NZ = found
        or      a
        ret

cs_fail:
        pop     bc
        xor     a                       ; Z = keep looking
        ret

;=============================================================================
; mb_status - read STATUS into A
;=============================================================================
mb_status:
        push    bc
        push    de
        push    hl
        ld      a,(slot)
        ld      hl,#ST_ADDR
        call    RDSLT
        pop     hl
        pop     de
        pop     bc
        ret

;=============================================================================
; mb_send - send the byte in E to the host
;
; Spins while TX_FULL, but only for a bounded number of tries: if the host
; stops reading, dropping the report is better than hanging the MSX.
;=============================================================================
mb_send:
        push    bc
        push    de
        push    hl
        ld      bc,#0                   ; 65536 tries
tx_wait:
        call    mb_status
        and     #ST_TX_FULL
        jr      z,tx_go
        dec     bc
        ld      a,b
        or      c
        jr      nz,tx_wait
        jr      tx_out                  ; still full - drop it

tx_go:
        pop     hl
        pop     de
        push    de
        push    hl
        ld      hl,#TX_ADDR
        ld      a,(slot)
        call    WRSLT                   ; E = byte
tx_out:
        pop     hl
        pop     de
        pop     bc
        ret

;=============================================================================
; Console helpers
;=============================================================================
puts:                                   ; HL -> $-terminated string
        push    bc
        push    de
        ex      de,hl
        ld      c,#F_STROUT
        call    BDOS
        pop     de
        pop     bc
        ret

putchar:                                ; A = character
        push    bc
        push    de
        push    hl
        ld      e,a
        ld      c,#F_CONOUT
        call    BDOS
        pop     hl
        pop     de
        pop     bc
        ret

crlf:
        ld      hl,#msg_crlf
        jr      puts

puthex:                                 ; A = byte -> two hex digits
        push    af
        rrca
        rrca
        rrca
        rrca
        call    puthex_nibble
        pop     af
        call    puthex_nibble
        ret

puthex_nibble:
        and     #0x0F
        add     a,#0x30
        cp      #0x3A
        jr      c,ph_out
        add     a,#7
ph_out:
        jp      putchar

;=============================================================================
; Data
;=============================================================================
sig:            .ascii  "PDSERIAL"
slot:           .db     0
bios_slot:      .db     0
rec:            .ds     REC_LEN

msg_notfound:   .ascii  "No PicoDock found - is the firmware flashed?"
                .db     0x0D, 0x0A
                .ascii  "$"
msg_nohost:     .ascii  "The cartridge is here but no host is - plug in the USB"
                .db     0x0D, 0x0A
                .ascii  "cable and start serve.sh."
                .db     0x0D, 0x0A
                .ascii  "$"
msg_sent:       .ascii  "PDINFO: "
                .ascii  "$"
msg_done:       .ascii  "Sent to the host - see the Status pane."
                .db     0x0D, 0x0A
                .ascii  "$"
msg_crlf:       .db     0x0D, 0x0A
                .ascii  "$"
