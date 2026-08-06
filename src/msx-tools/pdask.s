;-----------------------------------------------------------------------------
; PDASK.COM - ask the host a question from MSX-DOS, and print what comes back
;
;   A>PDASK give me a haiku about cassette tapes
;
; What this is for
;   The same conversation as CALL PDASK("..."), one layer down: no ROM, no
;   reflashing, nothing but a .COM on the disk. It exists so the host half - the
;   protocol, the person typing the answer, the search, the cutting - can be
;   tried on real hardware with the cartridge that is already flashed, and so
;   that when CALL PDASK misbehaves there is a way to tell which end is wrong.
;
;   The wire protocol below is exactly the one the ROM handler speaks
;   (src/nextor-driver/picodock-drv_basstat.patch). If this works and CALL PDASK
;   does not, the fault is in the ROM, not in the host.
;
; Why the slot scan
;   Under MSX-DOS page 1 (0x4000-0x7FFF) is RAM, so the mailbox has to be
;   reached with an inter-slot access, and the cartridge's slot is not known in
;   advance. Read 0x7F00 in every slot and subslot; whichever answers
;   "PDSERIAL" is ours. (Verified on hardware 2026-07-24 as PDPROBE.COM, which
;   this is descended from - see archive/src/msx-tools/pdprobe.s.)
;
; The protocol (../host/pd_ask.py has the other side)
;   MSX -> host                     host -> MSX
;     01 LO HI <query>   ask          81 LEN <bytes>   a chunk of the answer
;     03                 cancel       82               that was all of it
;     06                 ack          8F CODE          no answer, and why
;
;   Every chunk is acknowledged before the next is sent. The cartridge RX ring
;   is 1KB and drops what overruns it, so the ack is what keeps a long answer
;   from arriving with holes in it.
;
; Registers (see src/picoverse-picodock/pd_mailbox.h)
;   0x7F00-0x7F07  "PDSERIAL"   signature
;   0x7F08  R      STATUS       bit0 RX_READY / bit1 TX_FULL / bit2 USB_CONN
;   0x7F09  R      RX_DATA      host -> MSX, pure read (queue does not advance)
;   0x7F0A  W      TX_DATA      MSX -> host
;   0x7F0B  W      RX_ACK       consume the current RX byte
;
; On the host:  ./dist/disk/serve.sh          (answers are typed there)
;               ./dist/disk/serve.sh --ask google
;
; ESC gives up on an answer that is not coming.
;
; Build: ./src/msx-tools/build.sh
;
; (c) 2026 - part of the msx-serial project
;-----------------------------------------------------------------------------

        .area _CODE

BDOS     = 0x0005
F_TERM   = 0x00
F_CONOUT = 0x02
F_DIRIO  = 0x06                 ; E=FF: read a key without echo, 0 if none
F_STROUT = 0x09

RDSLT    = 0x000C               ; A = slot, HL = addr -> A = byte
WRSLT    = 0x0014               ; A = slot, HL = addr, E = byte
EXPTBL   = 0xFCC1               ; 4 bytes, bit7 = that primary slot is expanded

TAIL_LEN = 0x0080               ; DOS command tail: length, then the text
TAIL     = 0x0081

SIG_ADDR = 0x7F00
ST_ADDR  = 0x7F08
RX_ADDR  = 0x7F09
TX_ADDR  = 0x7F0A
ACK_ADDR = 0x7F0B

ST_RX_READY = 0x01
ST_TX_FULL  = 0x02
ST_USB_CONN = 0x04

OP_REQ    = 0x01
OP_CANCEL = 0x03
OP_ACK    = 0x06
OP_CHUNK  = 0x81
OP_END    = 0x82
OP_ERR    = 0x8F

KEY_ESC  = 0x1B

;=============================================================================
; The question is the command tail. Nothing to ask is not an error worth an
; error message - it is someone who typed the name to see what it does.
;=============================================================================
        ld      a,(TAIL_LEN)
        or      a
        jr      nz,have_tail
usage:
        ld      hl,#msg_usage
        call    puts
        jp      quit

have_tail:
        ; Skip the space DOS leaves between the name and the tail (and any
        ; more the user typed).
        ld      hl,#TAIL
        ld      b,a
skip_sp:
        ld      a,(hl)
        cp      #0x20
        jr      nz,got_query
        inc     hl
        djnz    skip_sp
        jr      usage

got_query:
        ld      (query),hl
        ld      a,b
        ld      (query_len),a

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
        ; A host that is not there cannot answer. Say so instead of waiting
        ; for a reply that has nobody to write it.
        call    mb_status
        and     #ST_USB_CONN
        jr      nz,send_query
        ld      hl,#msg_nohost
        call    puts
        jp      quit

;=============================================================================
; Ask: 01 LO HI then the query bytes.
;=============================================================================
send_query:
        ld      e,#OP_REQ
        call    mb_send
        ld      a,(query_len)
        ld      e,a
        call    mb_send
        ld      e,#0                    ; the DOS tail cannot reach 256 bytes
        call    mb_send

        ld      a,(query_len)
        ld      b,a
        ld      hl,(query)
q_loop:
        ld      e,(hl)
        push    hl
        push    bc
        call    mb_send
        pop     bc
        pop     hl
        inc     hl
        djnz    q_loop

        ld      hl,#msg_asked
        call    puts

;=============================================================================
; Read the answer. One chunk at a time, acknowledged, until 82 or 8F.
;=============================================================================
recv_loop:
        call    mb_get
        jr      c,cancelled
        cp      #OP_END
        jr      z,answered
        cp      #OP_ERR
        jr      z,refused
        cp      #OP_CHUNK
        jr      nz,recv_loop            ; noise, or a frame we do not know: resync

        call    mb_get                  ; chunk length
        jr      c,cancelled
        or      a
        jr      z,chunk_done            ; an empty chunk is still a chunk
        ld      b,a
chunk_loop:
        push    bc
        call    mb_get
        pop     bc
        jr      c,cancelled
        call    putchar
        djnz    chunk_loop
chunk_done:
        ld      e,#OP_ACK
        call    mb_send
        jr      recv_loop

answered:
        call    crlf
        jp      quit

refused:
        call    mb_get                  ; the reason, as a number
        jr      c,cancelled
        push    af
        call    crlf
        ld      hl,#msg_refused
        call    puts
        pop     af
        call    puthex
        call    crlf
        jp      quit

cancelled:
        ld      e,#OP_CANCEL
        call    mb_send
        call    crlf
        ld      hl,#msg_cancel
        call    puts

quit:
        ld      c,#F_TERM
        jp      BDOS

;=============================================================================
; check_slot - does the slot in A hold the signature at 0x7F00?
;
; Returns NZ when it matches, and stores the slot in `slot`. The result is not
; returned in the Z flag from a compare, because slot 0 is a legal slot number
; and every "set the flags from A" trick would report it as a mismatch.
;=============================================================================
check_slot:
        push    bc                      ; B/C carry the caller's slot counters
        ld      (slot),a
        ld      de,#sig
        ld      hl,#SIG_ADDR
        ld      b,#8
cs_loop:
        push    bc
        push    de
        push    hl
        ld      a,(slot)
        call    RDSLT                   ; A = byte, modifies BC/DE
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
; mb_get - the next byte from the host into A. Cy set if ESC was pressed.
;
; Blocks: the person at the other end may be typing, and there is no useful
; timeout for that. ESC is the way out, and it is checked between polls rather
; than after a fixed number of them, so it answers immediately.
;=============================================================================
mb_get:
        push    bc
        push    de
        push    hl
mg_wait:
        call    mb_status
        and     #ST_RX_READY
        jr      nz,mg_take

        ld      c,#F_DIRIO
        ld      e,#0xFF
        call    BDOS
        cp      #KEY_ESC
        jr      z,mg_cancel
        jr      mg_wait

mg_take:
        ld      a,(slot)
        ld      hl,#RX_ADDR
        call    RDSLT                   ; A = byte
        push    af
        ld      a,(slot)
        ld      hl,#ACK_ADDR
        ld      e,#0                    ; the value is ignored by RX_ACK
        call    WRSLT
        pop     af
        pop     hl
        pop     de
        pop     bc
        or      a                       ; Cy = 0: a byte, not a cancel
        ret

mg_cancel:
        pop     hl
        pop     de
        pop     bc
        scf
        ret

;=============================================================================
; mb_send - send the byte in E to the host
;
; Spins while TX_FULL, but only for a bounded number of tries: if the host
; stops reading, giving up is better than hanging the MSX with no way out.
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
        jr      tx_out                  ; still full - drop the byte

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
query:          .dw     0
query_len:      .db     0

msg_usage:      .ascii  "PDASK - ask the host something."
                .db     0x0D, 0x0A
                .ascii  "  A>PDASK give me a haiku about cassette tapes"
                .db     0x0D, 0x0A
                .ascii  "The host answers: someone types it, or a search does."
                .db     0x0D, 0x0A
                .ascii  "$"
msg_notfound:   .ascii  "No PicoDock found - is the firmware flashed?"
                .db     0x0D, 0x0A
                .ascii  "$"
msg_nohost:     .ascii  "The cartridge is here but no host is - plug in the USB"
                .db     0x0D, 0x0A
                .ascii  "cable and start serve.sh."
                .db     0x0D, 0x0A
                .ascii  "$"
msg_asked:      .ascii  "asked - waiting (ESC gives up)"
                .db     0x0D, 0x0A
                .ascii  "$"
msg_refused:    .ascii  "No answer. Reason 0x$"
msg_cancel:     .ascii  "Gave up."
                .db     0x0D, 0x0A
                .ascii  "$"
msg_crlf:       .db     0x0D, 0x0A
                .ascii  "$"
