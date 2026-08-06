# Pico firmware build environment - `. src/env.sh`, then run cmake.
#
# Both variables can be set in your shell beforehand; what is here is only the
# default for the layout the install lines below produce. If your SDK lives
# somewhere else, export PICO_SDK_PATH and PICO_TOOLCHAIN_PATH and this file
# leaves them alone.
#
# WARNING: Homebrew's arm-none-eabi-gcc ships without newlib (*.specs), so
#          bare-metal builds fail with "cannot read spec file 'nosys.specs'".
#          Use the official ARM toolchain below (a tarball, no sudo required).
#
# How to install what this expects:
#
#   brew install cmake ninja sdcc                       # macOS
#   sudo apt install cmake ninja-build sdcc             # Debian / Raspberry Pi OS
#
#   git clone --depth 1 -b 2.1.1 --recurse-submodules --shallow-submodules \
#     https://github.com/raspberrypi/pico-sdk.git "$HOME/work/pico-sdk"
#
#   mkdir -p "$HOME/work/toolchains"
#   # Pick the host triple for your machine from developer.arm.com: an Intel Mac
#   # is darwin-x86_64, Apple silicon darwin-arm64, a Raspberry Pi aarch64.
#   curl -fL https://developer.arm.com/-/media/Files/downloads/gnu/14.2.rel1/binrel/\
# arm-gnu-toolchain-14.2.rel1-darwin-x86_64-arm-none-eabi.tar.xz \
#     | tar xJ -C "$HOME/work/toolchains"
#
# Then set ARM_TOOLCHAIN below to whatever directory that unpacked, or export
# PICO_TOOLCHAIN_PATH yourself.

ARM_TOOLCHAIN=arm-gnu-toolchain-14.2.rel1-darwin-x86_64-arm-none-eabi

: "${PICO_SDK_PATH:=$HOME/work/pico-sdk}"
: "${PICO_TOOLCHAIN_PATH:=$HOME/work/toolchains/$ARM_TOOLCHAIN}"

export PICO_SDK_PATH PICO_TOOLCHAIN_PATH
