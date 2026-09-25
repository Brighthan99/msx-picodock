# picoverse-picodock — multirom (slot bus + mappers, core0) + CDC device (core1)
#
# Derived from:
#   prev-dev/software/multirom.pio/pico/multirom   (multirom.c, sunrise_ide.c, msx_bus.pio)
#   prev-dev/software/loadrom.pio/pico/printer     (CDC descriptors + core1 pump -> pd_usb.c)
# (c) 2026 Cristiano Goncalves

cmake_minimum_required(VERSION 3.13)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(PICO_BOARD pico CACHE STRING "Board type")

include(pico_sdk_import.cmake)

project(picoverse_pdser C CXX ASM)

pico_sdk_init()

add_executable(picoverse_pdser
    ${PICO_SDK_PATH}/lib/tinyusb/src/tusb.c
    multirom.c
    sunrise_ide.c
    pd_usb.c
    pd_mailbox.c
    pd_voice_win.c
    pd_stdprint.c
    pd_midipac.c
    pd_msxmidi.c
)

pico_generate_pio_header(picoverse_pdser ${CMAKE_CURRENT_LIST_DIR}/msx_bus.pio)

target_include_directories(picoverse_pdser PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}
    ${PICO_SDK_PATH}/lib/tinyusb/src
)

# The native USB port is a DEVICE here (CDC to the Mac), not a host.
# Guards the USB-storage block in sunrise_ide.c — see the note there.
target_compile_definitions(picoverse_pdser PRIVATE
    PD_ENABLE_USB_HOST=0
    # 음성 링의 MSX 쪽은 버스 핸들러 안에서 돈다 - 거기서 플래시를 가지러 가면
    # Z80 이 그 정지를 **틀린 바이트로** 본다. 그래서 카트리지에서는 RAM 에
    # 둔다. 그렇다고 pd_voice_win.c 가 SDK 헤더를 직접 들이면 PC 에서 못 짓고,
    # 그러면 굽기 전에 링을 시험할 곳이 없어진다(tests/test_pd_voice_win.c).
    # 그래서 매크로만 빌드가 건네준다.
    PD_VOICE_ON_CART=1
)

# Standard MSX printer port (0x90/0x91) support — how the MSX prints. Two
# INDEPENDENT halves, split so a real MSX with a physical printer port can carry
# only the write half (see bus_contention_and_port_conflicts.md).
#
#   PD_P90_READ       answer IN 0x90 with a constant "ready" byte, which means
#                        driving the bus. Compiled in but **disabled at boot**:
#                        nothing drives 0x90 until PDFRCPRN.COM sends its knock
#                        (multirom.c, P90_KNOCK_PORT), and PDFRCPRN only knocks
#                        after it has positively identified an OCM. That runtime
#                        gate is the safety, not this flag - so leaving the flag
#                        on costs nothing on a real MSX and is the default.
#   PD_STDPRINT_WRITE capture 0x90/0x91 data+strobe writes (pure bus snoop,
#                        SAFE on any machine).
#   PD_P90_STATUS     both of the above. On by default: it is what makes LPRINT
#                        and COPY ... PRN work with no MSX-side tool at all.
#
# Minimal build, if you want the read responder not merely disabled but absent:
#   cmake -DPD_P90_STATUS=OFF -DPD_STDPRINT_WRITE=ON ...
option(PD_P90_READ       "0x90 read responder — off at boot, armed by PDFRCPRN"    OFF)
option(PD_STDPRINT_WRITE "Capture 0x90/0x91 printer writes (safe anywhere)"        OFF)
option(PD_P90_STATUS     "Both halves: the standard printer port"                  ON)
# MSX-MIDI status (0xE9). Answers IN 0xE9 with 0x05 (TxRDY | TxEMPTY) on a
# machine that has no MSX-MIDI of its own - the Sony HB-F1XD, say - so that
# MIDRY /I5 and friends find an interface and their 0xE8 bytes, which the
# cartridge already passes to USB-MIDI, get sent at all. Disabled at boot and
# armed by PDMIDI.COM, which knocks only after reading 0xFF at 0xE9. On an OCM
# the FPGA answers 0xE9 itself and PDMIDI leaves this off.
option(PD_MIDI_STATUS    "0xE9 MSX-MIDI status responder — off at boot, armed by PDMIDI" ON)
# Diagnostic build only, never a shipping one. Echoes knock-port writes and the
# first serviced 0x90 read onto the print capture, so a hardware fault can be
# located without a debugger. Never ship this on.
option(PD_DIAG_KNOCK     "DIAG: trace the PDFRCPRN knock onto the print stream"   OFF)
if(PD_P90_STATUS)
    set(PD_P90_READ ON)
    set(PD_STDPRINT_WRITE ON)
endif()
if(PD_P90_READ)
    target_compile_definitions(picoverse_pdser PRIVATE PD_P90_READ=1)
endif()
if(PD_MIDI_STATUS)
    target_compile_definitions(picoverse_pdser PRIVATE PD_MIDI_STATUS=1)
endif()
if(PD_DIAG_KNOCK)
    target_compile_definitions(picoverse_pdser PRIVATE PD_DIAG_KNOCK=1)
endif()
if(PD_STDPRINT_WRITE)
    target_compile_definitions(picoverse_pdser PRIVATE PD_STDPRINT_WRITE=1)
endif()

target_link_libraries(picoverse_pdser
    pico_stdlib
    pico_multicore
    hardware_pio
    hardware_dma
    hardware_flash
    hardware_sync
    pico_unique_id
    tinyusb_board
    tinyusb_device
)

# No stdio over USB (the CDC interface is ours) and none over UART by default.
pico_enable_stdio_usb(picoverse_pdser 0)
pico_enable_stdio_uart(picoverse_pdser 0)

pico_add_extra_outputs(picoverse_pdser)
