// MSX PICOVERSE PROJECT
// (c) 2026 Cristiano Goncalves
// The Retro Hacker
//
// sunrise_ide.c - Sunrise IDE emulation for MSX PicoVerse
//
// Emulates the Sunrise MSX IDE interface hardware by intercepting memory-mapped
// reads/writes in the 0x4000-0x7FFF range and translating ATA commands into
// USB Mass Storage Class operations via TinyUSB on the RP2040 USB-C port.
//
// Architecture:
//   Core 0: PIO bus engine + Sunrise mapper/IDE register handling
//   Core 1: TinyUSB USB host stack + MSC block read/write operations
//
// This work is licensed under a "Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
// License". https://creativecommons.org/licenses/by-nc-sa/4.0/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "pico/stdlib.h"
#include "pico/sync.h"
#include "bsp/board.h"
#include "tusb.h"
#include "class/msc/msc_host.h"
#include "sunrise_ide.h"

// -----------------------------------------------------------------------
// USB MSC state (Core 1 only, except where noted volatile/shared)
// -----------------------------------------------------------------------
static sunrise_ide_t *usb_ide_ctx = NULL;

static scsi_inquiry_resp_t inquiry_resp;

static uint8_t current_dev_addr = 0;
static uint8_t current_lun = 0;
static volatile bool usb_device_mounted = false;
static volatile uint32_t usb_block_count = 0;
static volatile uint32_t usb_block_size = 0;

// Block I/O buffers — aligned for DMA.
// usb_read_buffer is 4096 bytes to accommodate devices with 4K native sectors.
// Each USB read fetches one native block; we extract the correct 512-byte slice.
CFG_TUH_MEM_SECTION TU_ATTR_ALIGNED(4) static uint8_t usb_read_buffer[4096];
CFG_TUH_MEM_SECTION TU_ATTR_ALIGNED(4) static uint8_t usb_write_buffer[512];

// Pending request flags (set by Core 0/IDE handler, cleared by Core 1)
static volatile bool usb_read_requested = false;
static volatile uint32_t usb_read_lba = 0;
static volatile bool usb_write_requested = false;
static volatile uint32_t usb_write_lba = 0;

static volatile bool usb_read_in_progress = false;
static volatile bool usb_write_in_progress = false;

// Timestamp (in microseconds) when the current USB transfer started.
// Used for timeout detection — slow or stalled USB devices must not
// keep the IDE in BSY state indefinitely.
static volatile uint64_t usb_transfer_start_us = 0;

// Maximum time (microseconds) to wait for a single USB sector transfer.
// USB Full Speed (12 Mbps): a 512-byte bulk transfer takes ~0.5 ms minimum.
// Slow devices may NAK for many frames during flash wear-levelling.
// Allow a generous 3 seconds to accommodate the slowest devices.
#define USB_TRANSFER_TIMEOUT_US  3000000u

// -----------------------------------------------------------------------
// ATA IDENTIFY DEVICE response builder
// -----------------------------------------------------------------------

// Write a fixed-length ATA string field into IDENTIFY words.
// ATA spec: first char in high byte (bits 15:8), second char in low byte (bits 7:0).
// src must be exactly len bytes (space-padded, not null-terminated).
static void ata_string_to_words(uint16_t *w, const char *src, int word_count)
{
    for (int i = 0; i < word_count; i++)
        w[i] = ((uint16_t)(uint8_t)src[i * 2] << 8) | (uint8_t)src[i * 2 + 1];
}

static void build_identify_data(uint8_t *buf)
{
    memset(buf, 0, 512);
    uint16_t *w = (uint16_t *)buf;

    // Word 0: General configuration
    w[0] = 0x0040;  // Fixed device, non-removable

    // Words 1-3: Legacy CHS geometry (fake values for LBA device)
    // The ATA interface presents 512-byte sectors to the MSX.
    // For devices with larger native sectors, multiply the block count.
    uint32_t total = usb_block_count;
    if (usb_block_size > 512)
        total *= (usb_block_size / 512);
    uint16_t heads = 16;
    uint16_t spt = 63;
    uint32_t cyls_calc = total / (heads * spt);
    uint16_t cyls = (cyls_calc > 16383) ? 16383 : (uint16_t)cyls_calc;
    w[1] = cyls;
    w[3] = heads;
    w[6] = spt;

    // Words 10-19: Serial number (20 ASCII chars, space-padded)
    char serial[20];
    memset(serial, ' ', 20);
    memcpy(serial, "PICOVERSE00000001", 17);
    ata_string_to_words(&w[10], serial, 10);

    // Words 23-26: Firmware revision (8 ASCII chars)
    // Use USB device's SCSI product revision if available
    char fwrev[8];
    memset(fwrev, ' ', 8);
    memcpy(fwrev, inquiry_resp.product_rev, 4);
    ata_string_to_words(&w[23], fwrev, 4);

    // Words 27-46: Model number (40 ASCII chars)
    // Use USB device's SCSI vendor + product identification
    char model[40];
    memset(model, ' ', 40);
    int pos = 0;
    for (int i = 0; i < 8; i++)
    {
        uint8_t c = (uint8_t)inquiry_resp.vendor_id[i];
        if (c >= 0x20 && c < 0x7F) model[pos++] = (char)c;
        else break;
    }
    // Trim trailing spaces from vendor
    while (pos > 0 && model[pos - 1] == ' ') pos--;
    if (pos > 0) model[pos++] = ' ';
    for (int i = 0; i < 16; i++)
    {
        uint8_t c = (uint8_t)inquiry_resp.product_id[i];
        if (c >= 0x20 && c < 0x7F) model[pos++] = (char)c;
        else break;
    }
    ata_string_to_words(&w[27], model, 20);

    // Word 47: Max sectors per READ/WRITE MULTIPLE (not used, but set to 1)
    w[47] = 0x0001;

    // Word 49: Capabilities — LBA supported
    w[49] = 0x0200;  // LBA supported

    // Word 53: Fields valid
    w[53] = 0x0001;

    // Words 54-56: Current CHS (same as legacy)
    w[54] = cyls;
    w[55] = heads;
    w[56] = spt;

    // Words 57-58: Current capacity in sectors (CHS)
    uint32_t chs_cap = (uint32_t)cyls * heads * spt;
    w[57] = (uint16_t)(chs_cap & 0xFFFF);
    w[58] = (uint16_t)(chs_cap >> 16);

    // Words 60-61: Total number of user addressable LBA sectors
    w[60] = (uint16_t)(total & 0xFFFF);
    w[61] = (uint16_t)(total >> 16);
}

// -----------------------------------------------------------------------
// IDE context initialisation
// -----------------------------------------------------------------------
// Set ATA registers to the power-on / post-reset / post-DEVDIAG state
// for a PATA master device (ATA/ATAPI-6 §9.2, §9.12).
static void ide_set_device_signature(sunrise_ide_t *ide)
{
    ide->error        = ATA_DIAG_NO_ERROR;  // diagnostic "no error"
    ide->sector_count = 0x01;               // PATA device signature
    ide->sector       = 0x01;
    ide->cylinder_low = 0x00;               // PATA: 0x0000
    ide->cylinder_high = 0x00;
    ide->device_head  = 0x00;               // master selected
    ide->status       = ATA_STATUS_DRDY | ATA_STATUS_DSC;
    ide->state        = IDE_STATE_IDLE;
    ide->usb_identify_pending = false;      // cancel any waiting IDENTIFY
}

void sunrise_ide_init(sunrise_ide_t *ide)
{
    memset((void *)ide, 0, sizeof(sunrise_ide_t));
    ide->segment = 0;
    ide->ide_enabled = false;
    ide->data_latch_valid = false;
    ide->buffer_index = 0;
    ide->buffer_length = 0;
    ide->sectors_remaining = 0;
    ide_set_device_signature(ide);
    // 음성 링도 여기서 씻는다. 전역이라 0 으로 시작하는데, **0 은 무음이
    // 아니라 진폭의 바닥**이라 아무것도 안 틀어도 딸깍 소리가 된다.
    // pd_voice_reset 이 가운데(128)로 올려 놓는다.
    pd_voice_reset(&sunrise_voice_ring);
}

// -----------------------------------------------------------------------
// Compute LBA from ATA registers (LBA mode)
// -----------------------------------------------------------------------
static inline uint32_t ide_get_lba(const sunrise_ide_t *ide)
{
    return (uint32_t)ide->sector
         | ((uint32_t)ide->cylinder_low << 8)
         | ((uint32_t)ide->cylinder_high << 16)
         | ((uint32_t)(ide->device_head & ATA_DEV_HEAD_HEAD_MASK) << 24);
}

// -----------------------------------------------------------------------
// Execute ATA command (called on write to command register 0x7E07)
// -----------------------------------------------------------------------
static void __not_in_flash_func(ide_execute_command)(sunrise_ide_t *ide, uint8_t cmd)
{
    // Only respond to master device (bit 4 = 0)
    if (ide->device_head & ATA_DEV_HEAD_DEV)
    {
        ide->status = ATA_STATUS_ERR;
        ide->error = ATA_ERROR_ABRT;
        ide->state = IDE_STATE_IDLE;
        return;
    }

    switch (cmd)
    {
    case ATA_CMD_IDENTIFY:
    {
        if (!usb_device_mounted)
        {
            // USB not enumerated yet — stay busy so the driver keeps
            // polling WAIT_DRQ (up to 5 s).  Core 1 will complete the
            // IDENTIFY once the USB device mounts.
            ide->status = ATA_STATUS_BSY;
            ide->error = 0;
            ide->state = IDE_STATE_BUSY;
            ide->usb_identify_pending = true;
            return;
        }
        build_identify_data(ide->sector_buffer);
        ide->buffer_index = 0;
        ide->buffer_length = 512;
        ide->data_latch_valid = false;
        ide->status = ATA_STATUS_DRDY | ATA_STATUS_DSC | ATA_STATUS_DRQ;
        ide->error = 0;
        ide->state = IDE_STATE_READ_DATA;
        break;
    }

    case ATA_CMD_READ_SECTORS:
    {
        if (!usb_device_mounted)
        {
            ide->status = ATA_STATUS_ERR;
            ide->error = ATA_ERROR_ABRT;
            ide->state = IDE_STATE_IDLE;
            return;
        }
        // ATA spec: sector_count==0 means 256 sectors
        uint16_t count = ide->sector_count ? ide->sector_count : 256;
        ide->sectors_remaining = count;
        ide->buffer_index = 0;
        ide->buffer_length = 0;
        ide->data_latch_valid = false;

        // Request first sector from USB
        uint32_t lba = ide_get_lba(ide);
        usb_read_lba = lba;
        ide->status = ATA_STATUS_BSY;
        ide->error = 0;
        ide->state = IDE_STATE_BUSY;
        usb_read_requested = true;
        break;
    }

    case ATA_CMD_WRITE_SECTORS:
    {
        if (!usb_device_mounted)
        {
            ide->status = ATA_STATUS_ERR;
            ide->error = ATA_ERROR_ABRT;
            ide->state = IDE_STATE_IDLE;
            return;
        }
        // ATA spec: sector_count==0 means 256 sectors
        uint16_t count = ide->sector_count ? ide->sector_count : 256;
        ide->sectors_remaining = count;
        ide->buffer_index = 0;
        ide->buffer_length = 512;
        ide->data_latch_valid = false;

        // Set DRQ immediately — MSX should start writing data
        ide->status = ATA_STATUS_DRDY | ATA_STATUS_DSC | ATA_STATUS_DRQ;
        ide->error = 0;
        ide->state = IDE_STATE_WRITE_DATA;
        break;
    }

    case ATA_CMD_SET_FEATURES:
    case ATA_CMD_INIT_PARAMS:
    case ATA_CMD_RECALIBRATE:
    {
        // Accept but do nothing
        ide->status = ATA_STATUS_DRDY | ATA_STATUS_DSC;
        ide->error = 0;
        ide->state = IDE_STATE_IDLE;
        break;
    }

    case ATA_CMD_DEVICE_DIAG:
    {
        // EXECUTE DEVICE DIAGNOSTIC (0x90)
        // After this command, the error register must contain the
        // diagnostic code: 0x01 = no error.  The Nextor Sunrise IDE
        // driver (CHKDIAG) reads IDE_ERROR and expects bits[6:0]==1
        // for success; any other value is mapped to an error string.
        ide_set_device_signature(ide);
        break;
    }

    case ATA_CMD_DEVICE_RESET:
    {
        // DEVICE RESET (0x08) — intended for ATAPI devices only;
        // for our ATA device, treat it the same as a post-reset state.
        ide_set_device_signature(ide);
        break;
    }

    default:
    {
        // Unknown command — abort
        ide->status = ATA_STATUS_DRDY | ATA_STATUS_ERR;
        ide->error = ATA_ERROR_ABRT;
        ide->state = IDE_STATE_IDLE;
        break;
    }
    }
}

// -----------------------------------------------------------------------
// Advance LBA registers to next sector (after a sector read/write)
// -----------------------------------------------------------------------
static void __not_in_flash_func(ide_advance_lba)(sunrise_ide_t *ide)
{
    uint32_t lba = ide_get_lba(ide) + 1;
    ide->sector = (uint8_t)(lba & 0xFF);
    ide->cylinder_low = (uint8_t)((lba >> 8) & 0xFF);
    ide->cylinder_high = (uint8_t)((lba >> 16) & 0xFF);
    ide->device_head = (ide->device_head & 0xF0) | (uint8_t)((lba >> 24) & 0x0F);
}

// -----------------------------------------------------------------------
// Handle write to Sunrise address space (0x4000-0x7FFF)
// Returns true if the write was consumed (not regular ROM write)
// -----------------------------------------------------------------------
bool __not_in_flash_func(sunrise_ide_handle_write)(sunrise_ide_t *ide, uint16_t addr, uint8_t data)
{
    // --- Segment/IDE control register at 0x4104 ---
    // The Sunrise IDE chgbnk routine bit-reverses the bank number before
    // writing: bank bit0→reg bit7, bit1→reg bit6, bit2→reg bit5.
    // The real hardware (and Carnivore2 VHDL) reverses them back:
    //   IDEROMADDR <= cReg(5) & cReg(6) & cReg(7) & Addr(13..0)
    // We must do the same reversal to recover the actual page number.
    if (addr == SUNRISE_CTRL_REG_ADDR)
    {
        uint8_t raw = (data >> 5) & 0x07;  // bits [7:5] as 3-bit value
        // Reverse 3 bits: {bit2,bit1,bit0} → {bit0,bit1,bit2}
        ide->segment = (uint8_t)(((raw & 4) >> 2) | (raw & 2) | ((raw & 1) << 2));
        ide->ide_enabled = (data & 0x01) != 0;
        return true;
    }

    // If IDE is not enabled, no IDE registers are mapped
    if (!ide->ide_enabled)
        return false;

    // --- IDE data register write (16-bit with latch): 0x7C00-0x7DFF ---
    if (addr >= IDE_DATA_BASE && addr <= IDE_DATA_END)
    {
        if (ide->state != IDE_STATE_WRITE_DATA)
            return true;  // consume but ignore if not in write state

        if ((addr & 1) == 0)
        {
            // Low byte — latch it
            ide->data_latch = data;
            ide->data_latch_valid = true;
        }
        else
        {
            // High byte — store the word (low byte was latched)
            uint8_t lo = ide->data_latch_valid ? ide->data_latch : 0x00;
            ide->data_latch_valid = false;

            if (ide->buffer_index < 512)
            {
                ide->sector_buffer[ide->buffer_index++] = lo;
            }
            if (ide->buffer_index < 512)
            {
                ide->sector_buffer[ide->buffer_index++] = data;
            }

            // Check if we've received a full sector
            if (ide->buffer_index >= 512)
            {
                ide->sectors_remaining--;
                ide->buffer_index = 0;

                // Copy data to USB write buffer and request write
                memcpy(usb_write_buffer, ide->sector_buffer, 512);
                usb_write_lba = ide_get_lba(ide);
                ide->status = ATA_STATUS_BSY;
                ide->state = IDE_STATE_BUSY;
                usb_write_requested = true;
            }
        }
        return true;
    }

    // --- IDE registers write: 0x7E00-0x7EFF ---
    if (addr >= IDE_REG_BASE && addr <= IDE_REG_END)
    {
        uint8_t reg = addr & 0x0F;
        switch (reg)
        {
        case IDE_REG_FEATURE:       ide->feature = data; break;
        case IDE_REG_SECTOR_COUNT:  ide->sector_count = data; break;
        case IDE_REG_SECTOR:        ide->sector = data; break;
        case IDE_REG_CYLINDER_LOW:  ide->cylinder_low = data; break;
        case IDE_REG_CYLINDER_HIGH: ide->cylinder_high = data; break;
        case IDE_REG_DEVICE_HEAD:   ide->device_head = data; break;
        case IDE_REG_COMMAND:
            ide_execute_command(ide, data);
            break;
        case IDE_REG_DEVICE_CTRL:
            // Bit 2 = SRST (software reset)
            if (data & 0x04)
            {
                // SRST asserted — device goes busy
                ide->status = ATA_STATUS_BSY;
                ide->state = IDE_STATE_IDLE;
            }
            else
            {
                // SRST deasserted (or nIEN-only write) —
                // set the post-reset device signature so that
                // GETDEVTYPE finds the PATA signature (cyl=0x0000)
                // and CHKDIAG sees error=0x01 (no error).
                ide_set_device_signature(ide);
            }
            break;
        default:
            break;
        }
        return true;
    }

    return false;  // Not an IDE address
}

// -----------------------------------------------------------------------
// Handle read from Sunrise address space (0x4000-0x7FFF)
// Returns true if *data_out should be returned instead of ROM data
// -----------------------------------------------------------------------
bool __not_in_flash_func(sunrise_ide_handle_read)(sunrise_ide_t *ide, uint16_t addr, uint8_t *data_out)
{
    // Reads to 0x4104 return normal ROM contents (not the control register)
    // IDE registers only visible when ide_enabled is true
    if (!ide->ide_enabled)
        return false;

    // --- IDE data register read (16-bit with latch): 0x7C00-0x7DFF ---
    if (addr >= IDE_DATA_BASE && addr <= IDE_DATA_END)
    {
        if (ide->state != IDE_STATE_READ_DATA)
        {
            *data_out = 0xFF;
            return true;
        }

        if ((addr & 1) == 0)
        {
            // Low byte read — fetch a word from the buffer, latch high byte
            uint8_t lo = 0xFF, hi = 0xFF;
            if (ide->buffer_index < ide->buffer_length)
                lo = ide->sector_buffer[ide->buffer_index++];
            if (ide->buffer_index < ide->buffer_length)
                hi = ide->sector_buffer[ide->buffer_index];
            // Don't increment high byte index yet — it will be read next

            ide->data_latch = hi;
            ide->data_latch_valid = true;
            *data_out = lo;
        }
        else
        {
            // High byte read — return latched value and advance
            *data_out = ide->data_latch_valid ? ide->data_latch : 0xFF;
            ide->data_latch_valid = false;
            if (ide->buffer_index < ide->buffer_length)
                ide->buffer_index++;

            // Check if we've read the entire sector
            if (ide->buffer_index >= ide->buffer_length)
            {
                ide->sectors_remaining--;
                if (ide->sectors_remaining > 0)
                {
                    // Request next sector
                    ide_advance_lba(ide);
                    ide->buffer_index = 0;
                    ide->buffer_length = 0;
                    ide->data_latch_valid = false;
                    usb_read_lba = ide_get_lba(ide);
                    ide->status = ATA_STATUS_BSY;
                    ide->state = IDE_STATE_BUSY;
                    usb_read_requested = true;
                }
                else
                {
                    // All sectors transferred
                    ide->status = ATA_STATUS_DRDY | ATA_STATUS_DSC;
                    ide->state = IDE_STATE_IDLE;
                    ide->data_latch_valid = false;
                }
            }
        }
        return true;
    }

    // --- IDE registers read: 0x7E00-0x7EFF ---
    if (addr >= IDE_REG_BASE && addr <= IDE_REG_END)
    {
        uint8_t reg = addr & 0x0F;
        switch (reg)
        {
        case IDE_REG_DATA:
            *data_out = 0xFF;  // Should use 0x7C00 instead
            break;
        case IDE_REG_ERROR:
            *data_out = ide->error;
            break;
        case IDE_REG_SECTOR_COUNT:
            *data_out = ide->sector_count;
            break;
        case IDE_REG_SECTOR:
            *data_out = ide->sector;
            break;
        case IDE_REG_CYLINDER_LOW:
            *data_out = ide->cylinder_low;
            break;
        case IDE_REG_CYLINDER_HIGH:
            *data_out = ide->cylinder_high;
            break;
        case IDE_REG_DEVICE_HEAD:
            *data_out = ide->device_head;
            break;
        case IDE_REG_STATUS:
            // Reading status clears the error flag (convention)
            *data_out = ide->status;
            break;
        case IDE_REG_ALT_STATUS:
            *data_out = ide->status;
            break;
        default:
            *data_out = 0xFF;
            break;
        }
        return true;
    }

    return false;  // Not an IDE address — return ROM data
}

// -----------------------------------------------------------------------
// [PDSER] USB HOST BLOCK
// -----------------------------------------------------------------------
// The integrated PDSER firmware runs the native USB port as a *device* (CDC to
// the host), so the TinyUSB *host* stack is not built.  Everything below needs
// host-only types (tuh_msc_complete_data_t) and would not even compile, so it
// is guarded out and replaced by stubs.  Consequence: mappers 10/11
// (Sunrise IDE / Nextor backed by a USB drive) have no storage behind them.
// The IDE register emulation above is untouched.
#if PD_ENABLE_USB_HOST

// -----------------------------------------------------------------------
// USB MSC callbacks (called from TinyUSB on Core 1)
// -----------------------------------------------------------------------

static bool read_complete_cb(uint8_t dev_addr, tuh_msc_complete_data_t const *cb_data);
static bool write_complete_cb(uint8_t dev_addr, tuh_msc_complete_data_t const *cb_data);

static bool inquiry_complete_cb(uint8_t dev_addr, tuh_msc_complete_data_t const *cb_data)
{
    if (cb_data->csw->status != 0)
        return false;

    usb_block_count = tuh_msc_get_block_count(dev_addr, cb_data->cbw->lun);
    usb_block_size = tuh_msc_get_block_size(dev_addr, cb_data->cbw->lun);

    usb_device_mounted = true;
    return true;
}

void tuh_msc_mount_cb(uint8_t dev_addr)
{
    current_dev_addr = dev_addr;
    current_lun = 0;
    usb_device_mounted = false;
    tuh_msc_inquiry(dev_addr, 0, &inquiry_resp, inquiry_complete_cb, 0);
}

void tuh_msc_umount_cb(uint8_t dev_addr)
{
    (void)dev_addr;
    current_dev_addr = 0;
    current_lun = 0;
    usb_device_mounted = false;
    usb_block_count = 0;
    usb_block_size = 0;
}

static bool read_complete_cb(uint8_t dev_addr, tuh_msc_complete_data_t const *cb_data)
{
    (void)dev_addr;
    usb_read_in_progress = false;

    if (usb_ide_ctx == NULL)
        return false;

    if (cb_data == NULL || cb_data->csw == NULL || cb_data->csw->status != 0)
    {
        usb_ide_ctx->usb_read_failed = true;
        return false;
    }

    // For devices with native sectors > 512 bytes (e.g. 4K), byte_offset
    // is the offset within the native block where our 512-byte ATA sector
    // lives.  It was passed via the user_arg parameter of tuh_msc_read10().
    uint32_t byte_offset = (uint32_t)cb_data->user_arg;

    // Copy the correct 512-byte slice to the IDE sector buffer.
    memcpy(usb_ide_ctx->sector_buffer, &usb_read_buffer[byte_offset], 512);

    __dmb();
    usb_ide_ctx->usb_read_ready = true;
    return true;
}

static bool write_complete_cb(uint8_t dev_addr, tuh_msc_complete_data_t const *cb_data)
{
    (void)dev_addr;
    usb_write_in_progress = false;

    if (usb_ide_ctx == NULL)
        return false;

    if (cb_data == NULL || cb_data->csw == NULL || cb_data->csw->status != 0)
    {
        usb_ide_ctx->usb_write_failed = true;
        return false;
    }

    usb_ide_ctx->usb_write_ready = true;
    return true;
}

// -----------------------------------------------------------------------
// USB task loop (runs on Core 1)
// -----------------------------------------------------------------------
void sunrise_usb_set_ide_ctx(sunrise_ide_t *ide)
{
    usb_ide_ctx = ide;
}

void __not_in_flash_func(sunrise_usb_task)(void)
{
    // Initialize TinyUSB host stack
    tusb_init();
    tuh_init(0);

    while (true)
    {
        tuh_task();

        if (usb_ide_ctx == NULL)
            continue;

        // --- Timeout watchdog for in-progress USB transfers ---
        // Slow or stalled USB devices must not leave IDE in permanent BSY.
        // If a transfer exceeds the timeout, treat it as a failure so the
        // MSX driver sees ERR and can retry or report the fault.
        if ((usb_read_in_progress || usb_write_in_progress) && usb_transfer_start_us != 0)
        {
            uint64_t elapsed = time_us_64() - usb_transfer_start_us;
            if (elapsed > USB_TRANSFER_TIMEOUT_US)
            {
                if (usb_read_in_progress)
                {
                    usb_read_in_progress = false;
                    usb_ide_ctx->usb_read_failed = true;
                }
                if (usb_write_in_progress)
                {
                    usb_write_in_progress = false;
                    usb_ide_ctx->usb_write_failed = true;
                }
                usb_transfer_start_us = 0;
            }
        }

        // --- Handle read request from Core 0 ---
        if (usb_read_requested && !usb_read_in_progress && usb_device_mounted)
        {
            usb_read_requested = false;
            usb_read_in_progress = true;
            usb_transfer_start_us = time_us_64();

            uint32_t lba = usb_read_lba;

            // Convert LBA if the USB device has non-512 byte sectors (e.g. 4K).
            // The ATA interface presents a 512-byte sector view to the MSX.
            // For devices with larger native sectors, we read the native sector
            // that contains the requested 512-byte LBA and extract the right
            // 512-byte slice.
            uint32_t native_lba = lba;
            uint32_t byte_offset = 0;
            if (usb_block_size > 512)
            {
                uint32_t sectors_per_block = usb_block_size / 512;
                native_lba = lba / sectors_per_block;
                byte_offset = (lba % sectors_per_block) * 512;
            }

            if (native_lba >= usb_block_count || usb_block_size == 0)
            {
                usb_read_in_progress = false;
                usb_transfer_start_us = 0;
                usb_ide_ctx->usb_read_failed = true;
            }
            else if (!tuh_msc_read10(current_dev_addr, current_lun, usb_read_buffer,
                                      native_lba, 1, read_complete_cb, (uintptr_t)byte_offset))
            {
                usb_read_in_progress = false;
                usb_transfer_start_us = 0;
                usb_ide_ctx->usb_read_failed = true;
            }
        }

        // --- Handle write request from Core 0 ---
        if (usb_write_requested && !usb_write_in_progress && usb_device_mounted)
        {
            usb_write_requested = false;
            usb_write_in_progress = true;
            usb_transfer_start_us = time_us_64();

            uint32_t lba = usb_write_lba;

            // For devices with native block size > 512 bytes, a single
            // 512-byte ATA write cannot be directly mapped to a native
            // block write (would require read-modify-write).  This is
            // extremely rare for USB flash drives; report an error if
            // it ever occurs rather than corrupting data.
            if (usb_block_size != 512)
            {
                usb_write_in_progress = false;
                usb_transfer_start_us = 0;
                usb_ide_ctx->usb_write_failed = true;
            }
            else if (lba >= usb_block_count)
            {
                usb_write_in_progress = false;
                usb_transfer_start_us = 0;
                usb_ide_ctx->usb_write_failed = true;
            }
            else if (!tuh_msc_write10(current_dev_addr, current_lun, usb_write_buffer,
                                       lba, 1, write_complete_cb, 0))
            {
                usb_write_in_progress = false;
                usb_transfer_start_us = 0;
                usb_ide_ctx->usb_write_failed = true;
            }
        }

        // --- Propagate USB completion status to IDE state machine ---
        // Memory barrier ensures sector_buffer writes from the callback
        // are fully committed before we transition the IDE state.
        if (usb_ide_ctx->usb_read_ready)
        {
            usb_ide_ctx->usb_read_ready = false;
            usb_transfer_start_us = 0;
            __dmb();
            usb_ide_ctx->buffer_index = 0;
            usb_ide_ctx->buffer_length = 512;
            usb_ide_ctx->data_latch_valid = false;
            usb_ide_ctx->status = ATA_STATUS_DRDY | ATA_STATUS_DSC | ATA_STATUS_DRQ;
            usb_ide_ctx->state = IDE_STATE_READ_DATA;
        }

        if (usb_ide_ctx->usb_read_failed)
        {
            usb_ide_ctx->usb_read_failed = false;
            usb_transfer_start_us = 0;
            usb_ide_ctx->status = ATA_STATUS_DRDY | ATA_STATUS_ERR;
            usb_ide_ctx->error = ATA_ERROR_ABRT;
            usb_ide_ctx->state = IDE_STATE_IDLE;
        }

        if (usb_ide_ctx->usb_write_ready)
        {
            usb_ide_ctx->usb_write_ready = false;
            usb_transfer_start_us = 0;
            ide_advance_lba(usb_ide_ctx);

            if (usb_ide_ctx->sectors_remaining > 0)
            {
                // More sectors to write — set DRQ for next sector
                usb_ide_ctx->buffer_index = 0;
                usb_ide_ctx->data_latch_valid = false;
                usb_ide_ctx->status = ATA_STATUS_DRDY | ATA_STATUS_DSC | ATA_STATUS_DRQ;
                usb_ide_ctx->state = IDE_STATE_WRITE_DATA;
            }
            else
            {
                // All sectors written
                usb_ide_ctx->status = ATA_STATUS_DRDY | ATA_STATUS_DSC;
                usb_ide_ctx->state = IDE_STATE_IDLE;
            }
        }

        if (usb_ide_ctx->usb_write_failed)
        {
            usb_ide_ctx->usb_write_failed = false;
            usb_transfer_start_us = 0;
            usb_ide_ctx->status = ATA_STATUS_DRDY | ATA_STATUS_ERR;
            usb_ide_ctx->error = ATA_ERROR_ABRT;
            usb_ide_ctx->state = IDE_STATE_IDLE;
        }

        // --- Complete a pending IDENTIFY after USB mount ---
        if (usb_ide_ctx->usb_identify_pending && usb_device_mounted)
        {
            usb_ide_ctx->usb_identify_pending = false;
            build_identify_data(usb_ide_ctx->sector_buffer);
            __dmb();
            usb_ide_ctx->buffer_index = 0;
            usb_ide_ctx->buffer_length = 512;
            usb_ide_ctx->data_latch_valid = false;
            usb_ide_ctx->status = ATA_STATUS_DRDY | ATA_STATUS_DSC | ATA_STATUS_DRQ;
            usb_ide_ctx->error = 0;
            usb_ide_ctx->state = IDE_STATE_READ_DATA;
        }
    }
}

#else  // !PD_ENABLE_USB_HOST

// -----------------------------------------------------------------------
// [PDSER] Host-backed block device (D4a)
// -----------------------------------------------------------------------
// The USB-drive backend above is gone: this firmware runs the native port as a
// CDC *device* to the host, so the storage lives on the host as a disk image.
// Everything the IDE state machine sees is unchanged - it still sets
// usb_read_requested / usb_read_lba and waits on ide->usb_read_ready - only the
// thing that fulfils those requests is different:
//
//     ATA command -> LBA -> BLK_READ_REQ over CDC -> host reads the image file
//
// This lives here rather than in its own file because the request flags and the
// write staging buffer above are file-static; keeping the backend next to them
// avoids exporting a pile of internals.
//
// Runs on **core1** via the pump hooks in pd_usb.h: TinyUSB is not multi-core
// safe, and moving 512-byte transfers off core0 keeps the slot-serving loop tight.
// The MSX is held with IDE BSY throughout, so a slow round trip is safe (just slow).

#include "pd_usb.h"
#include "pd_stdprint.h"
#include "pd_protocol_ids.h"
#include "pd_voice_win.h"
#include "pd_midipac.h"

#define BLK_SECTOR_SIZE   512u
#define BLK_TIMEOUT_US    3000000u      // same 3s budget the USB backend used

// 용량 문의(INFO)만은 훨씬 짧게 기다렸다가 다시 묻는다.
//
// READ/WRITE 는 MSX 가 요청해 놓고 BSY 로 기다리는 중이라, 3 초는 "여기까지만
// 붙잡고 있겠다" 는 상한이다. 반면 INFO 는 **아무도 기다리지 않는** 선행 질문이라
// 실패해도 잃을 것이 없다. 그런데도 3 초를 기다리면, 그 3 초 안에 Nextor 가
// IDENTIFY 를 하는 순간 용량을 모르는 채로 답해 `<failed>` 가 뜬다.
//
// 어긋나는 원인이 리눅스에 실재한다. pd_usb_connected() 는 DTR 이고,
// ModemManager 는 새 ttyACM 이 보이면 모뎀인지 떠보려고 포트를 열어 DTR 을
// 올린다. 카트리지는 그것을 서버로 착각해 INFO 를 던지지만 ModemManager 는
// 답할 줄 모르고, 그 동안 포트를 쥐고 있어 진짜 서버는 열지도 못한다.
// 3 초가 통째로 날아가는 창이 바로 거기다 (우분투에서 관측, 2026-09-19).
//
// 300 ms 면 MSX 부팅이 Nextor 에 닿기 전에 여러 번 다시 묻게 된다. 답이 오면
// usb_device_mounted 가 서고 바깥 if 가 막으므로 되풀이는 저절로 멈춘다.
#define BLK_INFO_RETRY_US  300000u

// Longest frame we send: SOF+CMD+LEN16 + (lba4+count1+512) + CHK
#define BLK_TX_MAX        (5u + 5u + BLK_SECTOR_SIZE)
// Longest frame we receive: SOF+CMD+LEN16 + (status1+512) + CHK
#define BLK_RX_PAYLOAD_MAX (1u + BLK_SECTOR_SIZE)
// Mailbox bytes per relayed frame. Small enough that a burst of MSX output can
// never delay a disk request by more than one frame; large enough that it is
// not one frame per keystroke.
#define MB_FRAME_MAX      256u

static sunrise_ide_t *blk_ide;

// --- transmit staging: a frame may not fit the CDC FIFO in one go ----------
static uint8_t  blk_tx[BLK_TX_MAX];
static uint16_t blk_tx_len;
static uint16_t blk_tx_sent;

// --- receive frame assembly ------------------------------------------------
typedef enum {
    RX_SOF = 0, RX_CMD, RX_LEN_LO, RX_LEN_HI, RX_PAYLOAD, RX_CHK
} blk_rx_state_t;

static blk_rx_state_t blk_rx_state;
static uint8_t  blk_rx_cmd;
static uint16_t blk_rx_len;
static uint16_t blk_rx_got;
static uint8_t  blk_rx_chk;
static uint8_t  blk_rx_payload[BLK_RX_PAYLOAD_MAX];

// --- outstanding request ---------------------------------------------------
typedef enum { BLK_IDLE = 0, BLK_WAIT_INFO, BLK_WAIT_READ, BLK_WAIT_WRITE } blk_wait_t;
static blk_wait_t blk_wait;
static uint64_t   blk_wait_since;
static bool       blk_info_asked;

static void blk_frame_begin(uint8_t cmd, uint16_t payload_len)
{
    blk_tx[0] = PD_SOF;
    blk_tx[1] = cmd;
    blk_tx[2] = (uint8_t)(payload_len & 0xFFu);
    blk_tx[3] = (uint8_t)(payload_len >> 8);
    blk_tx_len = 4u;
}

static void blk_frame_put(uint8_t b)
{
    if (blk_tx_len < BLK_TX_MAX - 1u)
        blk_tx[blk_tx_len++] = b;
}

static void blk_frame_end(void)
{
    uint8_t chk = 0;
    for (uint16_t i = 1; i < blk_tx_len; i++)
        chk ^= blk_tx[i];
    blk_tx[blk_tx_len++] = chk;
    blk_tx_sent = 0;
}

static void blk_put_u32(uint32_t v)
{
    blk_frame_put((uint8_t)(v & 0xFFu));
    blk_frame_put((uint8_t)((v >> 8) & 0xFFu));
    blk_frame_put((uint8_t)((v >> 16) & 0xFFu));
    blk_frame_put((uint8_t)((v >> 24) & 0xFFu));
}

// --- 음성 (pd_voice_win.h) --------------------------------------------------
//
// 호스트가 합성한 PSG 볼륨 스트림이 여기 링에 담기고, MSX 가 0x7F0C 를 읽을
// 때마다 한 바이트씩 나간다. 무거운 계산은 호스트에서 끝났고 카트리지가 할
// 일은 나르는 것뿐이다.
// **호출이 아니라 전역이다.** 버스 핸들러는 MSX 가 주소를 내놓을 때마다 여기
// 닿는데, 거기서 함수를 하나 부르면 그 함수가 플래시에 있는 한 정지가 생기고
// Z80 은 그 정지를 틀린 바이트로 읽는다. 주소를 그냥 아는 편이 싸다.
pd_voice_t sunrise_voice_ring;

static bool blk_tx_busy(void)
{
    return blk_tx_sent < blk_tx_len;
}

// 남이 이 파이프에 끼어들어도 되는지 묻는 자리. 프레임이 반쯤 나가 있는 동안
// PSG 스트림이 22 바이트를 밀어 넣으면 블록 프레임이 찢어진다.
static bool __not_in_flash_func(blk_pipe_busy)(void)
{
    return blk_tx_busy();
}

// 음성 상태를 호스트에게. **흐름 제어가 이것 하나에 달려 있다** - 호스트는
// 여기서 들은 자리만큼만 보낸다. 안 보내면 호스트는 링이 비었는지 알 수 없고,
// 모르는 채로 밀면 말이 넘쳐 사라진다.
//
// PSG 프레임과 같은 규칙: 자리가 모자라면 **아예 안 보낸다.** 잘린 프레임은
// 받는 쪽에서 다음 SOF 까지 버려지므로, 한 번 거르는 것보다 큰 구멍이 된다.
void sunrise_voice_tick(void)
{
    pd_voice_t *v = &sunrise_voice_ring;

    // MSX 가 멈췄다는 말은 **반드시 나가야 한다.** 호스트가 "말 다 했다" 를
    // 아는 길이 이것뿐이고, 못 들으면 다음 문장을 영영 거절한다. 그렇다고
    // 계속 보내면 아무도 말 안 하는 동안 파이프가 이것으로 찬다 - 그래서
    // 몇 번만 보내고 조용해진다.
    static uint8_t stop_sent;
    if (!v->stopped)
        stop_sent = 0;

    // 아무 일도 없을 때는 말하지 않는다. 링이 비어 있고 시작도 안 눌렀고
    // 닫히지도 않았고, 멈췄다는 말도 이미 했으면 보낼 것이 없다.
    if (v->head == v->tail && !v->armed && !v->closed
        && (!v->stopped || stop_sent >= 5u))
        return;

    // **주기를 둔다.** 이 함수는 core1 폴링 루프에서 불리므로 그냥 두면
    // 초에 수만 번 나가고, 그 자체로 파이프가 차서 정작 보낼 샘플이 못 간다.
    // 10 ms 는 110 샘플 - 512 바이트 프레임 하나가 46 ms 어치니 한 프레임
    // 나가는 동안 자리 소식이 네다섯 번 간다. 넉넉하면서 싸다.
    static uint64_t next_stat_us;
    const uint64_t now = time_us_64();
    if (now < next_stat_us)
        return;
    next_stat_us = now + 10000u;

    // 자리가 모자라면 **아예 보내지 않는다** - PSG 프레임과 같은 규칙.
    // 잘린 프레임은 받는 쪽에서 다음 SOF 까지 버려지므로 더 큰 구멍이 된다.
    if (pd_usb_write_room() < PD_VOICE_STAT_FRAME)
        return;

    // 형식은 pd_voice_win.c 에 있다 - 호스트에도 같은 형식을 읽는 코드가
    // 있고(node/src/voicestream.js), 한 형식을 두 군데 적으면 갈라진다.
    uint8_t f[PD_VOICE_STAT_FRAME];
    pd_usb_write(f, pd_voice_status_frame(v, f));
    if (v->stopped && stop_sent < 5u)
        stop_sent++;
}

// Drain the staged frame into the CDC FIFO as room appears.
static void blk_tx_pump(void)
{
    if (!blk_tx_busy())
        return;
    uint32_t n = pd_usb_write(&blk_tx[blk_tx_sent], (uint32_t)(blk_tx_len - blk_tx_sent));
    blk_tx_sent += (uint16_t)n;
}

// --- responses -------------------------------------------------------------
static void blk_handle_frame(void)
{
    switch (blk_rx_cmd)
    {
    case PD_BLK_INFO_RESP:
        if (blk_rx_len >= 7u && blk_rx_payload[0] == 0u)
        {
            usb_block_count = (uint32_t)blk_rx_payload[1] |
                              ((uint32_t)blk_rx_payload[2] << 8) |
                              ((uint32_t)blk_rx_payload[3] << 16) |
                              ((uint32_t)blk_rx_payload[4] << 24);
            usb_block_size  = (uint32_t)blk_rx_payload[5] |
                              ((uint32_t)blk_rx_payload[6] << 8);
            usb_device_mounted = true;
        }
        blk_wait = BLK_IDLE;
        break;

    case PD_BLK_READ_RESP:
        if (blk_wait != BLK_WAIT_READ || !blk_ide)
            break;
        if (blk_rx_len >= 1u + BLK_SECTOR_SIZE && blk_rx_payload[0] == 0u)
        {
            memcpy(blk_ide->sector_buffer, &blk_rx_payload[1], BLK_SECTOR_SIZE);
            blk_ide->usb_read_ready = true;
        }
        else
        {
            blk_ide->usb_read_failed = true;
        }
        blk_wait = BLK_IDLE;
        break;

    case PD_BLK_WRITE_RESP:
        if (blk_wait != BLK_WAIT_WRITE || !blk_ide)
            break;
        if (blk_rx_len >= 1u && blk_rx_payload[0] == 0u)
            blk_ide->usb_write_ready = true;
        else
            blk_ide->usb_write_failed = true;
        blk_wait = BLK_IDLE;
        break;

    case PD_CMD_CTRL:
        // 카트리지 자신에게 내리는 지시. MSX 로 중계되지 않는다.
        // [what:1][on:1] — 모르는 what 은 조용히 무시한다 (구형 펌웨어에
        // 새 호스트가 붙었을 때 오류를 내지 않기 위해서다).
        if (blk_rx_len >= 2u)
        {
            const bool on = (blk_rx_payload[1] != 0u);
            switch (blk_rx_payload[0])
            {
            case PD_CTRL_PSG_STREAM: pd_midipac_set_stream(on); break;
            case PD_CTRL_MIDIPAC:    pd_midipac_set_midi(on);   break;
            // 여기만 둘째 바이트가 불린이 아니라 값이다.
            case PD_CTRL_MIDI_PROG:  pd_midipac_set_program(blk_rx_payload[1]); break;
            default: break;
            }
        }
        break;

    case PD_CMD_VOICE_DATA:
        // 샘플을 링에 담는다. **자리가 없으면 그만큼만 받는다** - 호스트가
        // 자리를 보고 보내므로 여기서 넘치면 그쪽이 틀린 것이고, 막고
        // 있어 봐야 디스크까지 멈춘다.
        pd_voice_feed(&sunrise_voice_ring, blk_rx_payload, blk_rx_len);
        break;

    case PD_CMD_VOICE_CTRL:
        if (blk_rx_len >= 1u)
        {
            if (blk_rx_payload[0] == PD_VOICE_CLOSE)
                pd_voice_close(&sunrise_voice_ring);
            else
                pd_voice_reset(&sunrise_voice_ring);
        }
        break;

    case PD_CMD_MB_TO_MSX:
        // Mailbox payload for the MSX (B0). Hand it to the RX ring the mailbox
        // reads from. If the ring fills the MSX is not draining, and dropping
        // is the only option - blocking here would stall the disk as well.
        for (uint16_t i = 0; i < blk_rx_len; i++)
        {
            if (!pd_rx_put(blk_rx_payload[i]))
                break;
        }
        break;

    default:
        break;      // not ours; ignore
    }
}

void __not_in_flash_func(sunrise_host_blk_rx)(uint8_t b)
{
    switch (blk_rx_state)
    {
    case RX_SOF:
        if (b == PD_SOF)
            blk_rx_state = RX_CMD;
        break;                                  // resync: discard until SOF

    case RX_CMD:
        blk_rx_cmd = b;
        blk_rx_chk = b;
        blk_rx_state = RX_LEN_LO;
        break;

    case RX_LEN_LO:
        blk_rx_len = b;
        blk_rx_chk ^= b;
        blk_rx_state = RX_LEN_HI;
        break;

    case RX_LEN_HI:
        blk_rx_len |= (uint16_t)b << 8;
        blk_rx_chk ^= b;
        blk_rx_got = 0;
        if (blk_rx_len > BLK_RX_PAYLOAD_MAX)
            blk_rx_state = RX_SOF;              // absurd length: resync
        else
            blk_rx_state = blk_rx_len ? RX_PAYLOAD : RX_CHK;
        break;

    case RX_PAYLOAD:
        blk_rx_payload[blk_rx_got++] = b;
        blk_rx_chk ^= b;
        if (blk_rx_got >= blk_rx_len)
            blk_rx_state = RX_CHK;
        break;

    case RX_CHK:
        if (b == blk_rx_chk)
            blk_handle_frame();
        blk_rx_state = RX_SOF;
        break;
    }
}

// Turn completion flags into IDE state transitions.
//
// This is the half of the old USB task that was easy to miss: the IDE state
// machine only *raises* usb_read_ready / usb_write_ready and waits - the task
// was what actually moved status/state on. With that block compiled out the
// drive parked in BSY after the very first transfer, which looked like Nextor
// giving up after two reads and reporting "no suitable devices attached to the
// driver" (the driver was fine; the device never answered).
static void __not_in_flash_func(blk_complete)(void)
{
    sunrise_ide_t *ide = blk_ide;
    if (!ide)
        return;

    // An IDENTIFY that arrived before the host was ready parks in BSY with
    // usb_identify_pending set; finish it now that the capacity is known.
    if (ide->usb_identify_pending && usb_device_mounted)
    {
        ide->usb_identify_pending = false;
        build_identify_data(ide->sector_buffer);
        __dmb();
        ide->buffer_index = 0;
        ide->buffer_length = 512;
        ide->data_latch_valid = false;
        ide->status = ATA_STATUS_DRDY | ATA_STATUS_DSC | ATA_STATUS_DRQ;
        ide->error = 0;
        ide->state = IDE_STATE_READ_DATA;
    }

    if (ide->usb_read_ready)
    {
        ide->usb_read_ready = false;
        __dmb();                    // sector_buffer must be visible before DRQ
        ide->buffer_index = 0;
        ide->buffer_length = 512;
        ide->data_latch_valid = false;
        ide->status = ATA_STATUS_DRDY | ATA_STATUS_DSC | ATA_STATUS_DRQ;
        ide->state = IDE_STATE_READ_DATA;
    }

    if (ide->usb_read_failed)
    {
        ide->usb_read_failed = false;
        ide->status = ATA_STATUS_DRDY | ATA_STATUS_ERR;
        ide->error = ATA_ERROR_ABRT;
        ide->state = IDE_STATE_IDLE;
    }

    if (ide->usb_write_ready)
    {
        ide->usb_write_ready = false;
        ide_advance_lba(ide);

        if (ide->sectors_remaining > 0)
        {
            // More sectors to come - ask the MSX for the next one
            ide->buffer_index = 0;
            ide->data_latch_valid = false;
            ide->status = ATA_STATUS_DRDY | ATA_STATUS_DSC | ATA_STATUS_DRQ;
            ide->state = IDE_STATE_WRITE_DATA;
        }
        else
        {
            ide->status = ATA_STATUS_DRDY | ATA_STATUS_DSC;
            ide->state = IDE_STATE_IDLE;
        }
    }

    if (ide->usb_write_failed)
    {
        ide->usb_write_failed = false;
        ide->status = ATA_STATUS_DRDY | ATA_STATUS_ERR;
        ide->error = ATA_ERROR_ABRT;
        ide->state = IDE_STATE_IDLE;
    }
}

void __not_in_flash_func(sunrise_host_blk_poll)(void)
{
    blk_complete(); // drive the IDE state machine forward on completions

    blk_tx_pump();

    // 자리 소식은 블록 프레임과 **따로** 나간다. 아래는 디스크가 바쁘면
    // 돌아서는데, 그때도 말은 계속 재생되고 있고 호스트는 자리를 알아야
    // 한다 - 여기서 막히면 읽는 동안 소리에 구멍이 난다.
    sunrise_voice_tick();

    if (blk_tx_busy())
        return;                                  // finish sending first

    // Ask for the capacity once the host shows up, so IDENTIFY can answer.
    // 디스크를 서빙하지 않는 동안(일반 ROM 게임)에는 물어볼 이유가 없다 -
    // 파서는 CTRL 을 받으려고 돌고 있을 뿐이다.
    if (!usb_device_mounted && blk_ide)
    {
        if (blk_wait == BLK_IDLE && !blk_info_asked && pd_usb_connected())
        {
            blk_info_asked = true;
            blk_frame_begin(PD_BLK_INFO_REQ, 0);
            blk_frame_end();
            blk_wait = BLK_WAIT_INFO;
            blk_wait_since = time_us_64();
        }
        if (!pd_usb_connected())
            blk_info_asked = false;              // retry after a reconnect
    }

    if (blk_wait != BLK_IDLE)
    {
        // A stalled host must not leave the MSX in permanent BSY.
        const uint64_t budget = (blk_wait == BLK_WAIT_INFO) ? BLK_INFO_RETRY_US
                                                            : BLK_TIMEOUT_US;
        if (time_us_64() - blk_wait_since > budget)
        {
            if (blk_ide)
            {
                if (blk_wait == BLK_WAIT_READ)  blk_ide->usb_read_failed = true;
                if (blk_wait == BLK_WAIT_WRITE) blk_ide->usb_write_failed = true;
            }
            blk_wait = BLK_IDLE;
            blk_info_asked = false;
        }
        return;
    }

    if (usb_read_requested)
    {
        usb_read_requested = false;
        blk_frame_begin(PD_BLK_READ_REQ, 5u);
        blk_put_u32(usb_read_lba);
        blk_frame_put(1u);                       // one sector per request
        blk_frame_end();
        blk_wait = BLK_WAIT_READ;
        blk_wait_since = time_us_64();
        return;
    }

    if (usb_write_requested)
    {
        usb_write_requested = false;
        blk_frame_begin(PD_BLK_WRITE_REQ, (uint16_t)(5u + BLK_SECTOR_SIZE));
        blk_put_u32(usb_write_lba);
        blk_frame_put(1u);
        for (uint16_t i = 0; i < BLK_SECTOR_SIZE; i++)
            blk_frame_put(usb_write_buffer[i]);
        blk_frame_end();
        blk_wait = BLK_WAIT_WRITE;
        blk_wait_since = time_us_64();
        return;
    }

    // Mailbox bytes from the MSX (B0), last so the disk always wins. A keypress
    // waiting a few milliseconds is invisible; a disk read waiting is not, and
    // during a large copy the MSX is not typing anyway.
    //
    // Only once the disk is up *and* a host is listening. A staged frame makes
    // every later poll return early until it drains (blk_tx_busy above), so a
    // frame staged during bring-up - or with nothing reading the other end -
    // would hold off the very INFO request the disk is waiting on, and the MSX
    // would sit in BSY. Mailbox traffic is never worth that risk.
    if (!usb_device_mounted || !pd_usb_connected())
        return;

    uint8_t mb;
    if (pd_tx_get(&mb))
    {
        blk_frame_begin(PD_CMD_MB_TO_HOST, 0);
        blk_frame_put(mb);
        uint16_t n = 1;
        while (n < MB_FRAME_MAX && pd_tx_get(&mb))
        {
            blk_frame_put(mb);
            n++;
        }
        blk_tx[2] = (uint8_t)(n & 0xFFu);   // patch the length now that it is known
        blk_tx[3] = (uint8_t)(n >> 8);
        blk_frame_end();
        return;                             // one frame per poll; printer next time
    }

#ifdef PD_STDPRINT_WRITE
    // Printer bytes (0x40), lowest priority. A print job can be large, so it
    // must never delay a disk request; it drains a frame at a time between them.
    // This is the only capture path now - the private 0xF5/0xF6 one is in
    // archive/, replaced by the machine's own printer port.
    uint8_t sb;
    if (pd_stdprint_get(&sb))
    {
        blk_frame_begin(PD_CMD_PRINT_DATA, 0);
        blk_frame_put(sb);
        uint16_t n = 1;
        while (n < MB_FRAME_MAX && pd_stdprint_get(&sb))
        {
            blk_frame_put(sb);
            n++;
        }
        blk_tx[2] = (uint8_t)(n & 0xFFu);
        blk_tx[3] = (uint8_t)(n >> 8);
        blk_frame_end();
    }
#endif
}

/**
 * 호스트 프레임 파서를 IDE 없이 설치한다.
 *
 * **CTRL 프레임은 어느 ROM 이 돌든 닿아야 한다.** PSG 원음·MIDI-PAC·악기는
 * Nextor 와 무관하게 돌아가는데, 그것을 켜고 끄는 길만 Sunrise 모드에 묶여
 * 있었다 - 일반 ROM 게임을 돌리면 파서 자체가 없어서 호스트가 보낸 CTRL 이
 * 통째로 무시됐다. 화면에서 스위치를 눌러도 아무 일도 안 일어났고, 펌웨어
 * 기본값이 그대로 도는 것을 "잘 된다" 로 읽기 쉬웠다 (2026-09-21 실기).
 *
 * 블록 명령은 blk_ide 가 NULL 이면 저절로 걸러진다 - 응답 처리마다 이미
 * !blk_ide 를 보고 있고, 용량 문의도 아래에서 막는다.
 */
void sunrise_usb_init_hostlink(void)
{
    sunrise_usb_set_ide_ctx(NULL);
}

void sunrise_usb_set_ide_ctx(sunrise_ide_t *ide)
{
    blk_ide = ide;
    blk_rx_state = RX_SOF;
    blk_wait = BLK_IDLE;
    blk_tx_len = blk_tx_sent = 0;
    blk_info_asked = false;
    usb_device_mounted = false;

    // Take over the CDC receive path and get polled by the core1 pump.
    pd_usb_set_rx_sink(sunrise_host_blk_rx);
    pd_usb_set_poll_hook(sunrise_host_blk_poll);
    pd_usb_set_pipe_busy_hook(blk_pipe_busy);
}

void sunrise_usb_task(void)
{
    // Not a core1 entry point any more - core1 runs pd_usb_task and calls the
    // hooks above. Kept so multirom.c links unchanged.
    while (true)
        tight_loop_contents();
}

#endif // PD_ENABLE_USB_HOST
