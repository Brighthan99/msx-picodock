#include "fusion_sdcccall0.h"   // replaces <msx_fusion.h> — see that header for why
#include <stdio.h>
#include "bios.h"

// Define maximum files per page and screen properties
#define FILES_PER_PAGE 19   // Maximum files per page on the menu
#define MAX_FILE_NAME_LENGTH 50     // Maximum size of the ROM name
#define ROM_RECORD_SIZE (MAX_FILE_NAME_LENGTH + 1 + sizeof(unsigned long) + sizeof(unsigned long))  // Size of the ROM record in bytes
#define MAX_ROM_RECORDS 128 // Maximum ROM files supported
#define MEMORY_START 0x8000 // Start of the memory area to read the ROM records
#define ROM_SELECT_REGISTER 0x9D81 // Memory-mapped register that selects the ROM to load
#define JIFFY 0xFC9E

// [PDSER] Cartridge mailbox registers (must match src/picoverse-picodock/pd_mailbox.h)
#define PD_MB_STATUS   0xBFF0   // R  bit0 RX_READY / bit1 TX_FULL / bit2 USB_CONNECTED
#define PD_MB_RX_DATA  0xBFF1   // R  byte from the host (reading does not move the queue)
#define PD_MB_TX_DATA  0xBFF2   // W  MSX -> host
#define PD_MB_RX_ACK   0xBFF3   // W  consume the current RX byte

#define PD_ST_RX_READY 0x01
#define PD_ST_TX_FULL  0x02
#define PD_ST_USB_CONN 0x04

// Structure to represent a ROM record
// The ROM record will contain the name of the ROM, the mapper code, the size of the ROM and the offset in the flash memory
// Name: MAX_FILE_NAME_LENGTH bytes
// Mapper: 1 byte
// Size: 4 bytes
// Offset: 4 bytes
typedef struct {
    char Name[MAX_FILE_NAME_LENGTH + 1];
    unsigned char Mapper;
    unsigned long Size;
    unsigned long Offset;
} ROMRecord;


// Control Variables
int currentPage;    // Current page
int totalPages;     // Total pages
int currentIndex;   // Current file index
unsigned char totalFiles;     // Total files
unsigned long totalSize;
ROMRecord records[MAX_ROM_RECORDS]; // Array to store the ROM records

// Declare the functions
unsigned long read_ulong(const unsigned char *ptr);
int isEndOfData(const unsigned char *memory);
void readROMData(ROMRecord *records, unsigned char *recordCount, unsigned long *sizeTotal);
int putchar (int character);   // defined __naked in menu.c (the attribute would clash with stdio.h here)
void invert_chars(unsigned char startChar, unsigned char endChar);
void print_str_normal(const char *str);
void print_str_inverted(const char *str);
void print_str_inverted_padded(const char *str, unsigned char width);
const char* mapper_description(int number);
void charMap(); //debug
void displayMenu();
void navigateMenu();
void mailboxTest();          // [PDSER] D1a mailbox diagnostic
void helpMenu();
void loadGame(int index);
void main();



