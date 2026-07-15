# WatsUp Desktop Streamer - Setup & Operations Guide

An ultra-lightweight, browserless WhatsApp file streaming application designed for Ubuntu desktop environments (X11, RDP, or virtual desktops). This application is built with a highly decoupled, two-part architecture to deliver maximum performance and stability under extreme resource constraints.

---

## ⚙️ Architecture & Design

WatsUp Desktop Streamer consists of two independent local processes communicating via a secure loopback API:

```
[ Lightweight GUI ]  ====== (Path & JID JSON) ======>  [ Background Engine ]
 (ui.py - Python)    <====== (Real-time Status) =====   (engine.js - Node)
                                                                ||
                                                         (Stream 1MB Chunks)
                                                                ||
                                                                \/
                                                         [ WhatsApp Server ]
```

1.  **The Background Engine (`engine.js`)**: A silent Node.js daemon using the `@whiskeysockets/baileys` library. It connects directly to WhatsApp servers via raw WebSockets. It operates at **< 80MB RAM** at idle and exposes a local-only REST API on loopback `127.0.0.1:5001`.
2.  **The Desktop GUI (`ui.py`)**: A native Python desktop interface using standard `tkinter` and `ttk` libraries. It consumes **< 15MB RAM**, requires **zero pip dependencies**, and provides a responsive, dark-themed dashboard to select files, manage the queue, and select contacts.

### 🔒 IPC Security & Token Protection
The background engine generates a secure 32-byte dynamic token at startup inside `.watsup_ipc_token` (with strict `0o600` owner-only permissions). All REST API requests under `/api/*` are strictly authenticated via the `X-WatsUp-Token` header using a `crypto.timingSafeEqual` comparison.
> [!NOTE]
> This security token is designed to block unauthorized cross-origin or local processes from interfacing with your WhatsApp background socket. It reduces the local attack surface but is not a absolute protection against malware running with the same user privileges (since any process running as the current user could read the token file).

### ⚡ 100% Flat RAM Streaming Pipeline & File Splitting
Instead of loading massive files into RAM buffers, the Python GUI simply sends the absolute local file path string to the background engine. The engine opens a high-performance stream directly from the disk using a tuned **1 MB block size** (`highWaterMark`), encrypts it chunk-by-chunk, and feeds it straight to the network socket.

For files exceeding 1.95 GB:
- If `rar` CLI is available, the GUI splits the file into equally-sized RAR volumes.
- Otherwise, the GUI performs zero-RAM native binary splitting into raw chunks named `.part001`, `.part002`, etc.
- A `manifest.txt` file is generated inside the split directory containing file details and command line merge instructions (using `copy /b` on Windows or `cat` on Linux). This manifest is automatically sent to the recipient along with the parts to guide extraction.

---

## 🛠️ Setup & Operations

WatsUp Desktop Streamer provides an automated installer and launcher script (`launch.sh`) that takes care of checking and auto-installing all system and package dependencies.

### 1. Fresh/Clean Install (e.g., New RDP Container)

If you are setting up on a completely fresh RDP instance, you can clone and launch the application using a single command:

```bash
rm -rf ~/watsup && git clone https://github.com/ElkampaPro/watsup.git ~/watsup && cd ~/watsup && chmod +x launch.sh && ./launch.sh
```

This command will:
- Check for system prerequisites (`nodejs` v20 LTS, `python3`, `python3-tk`, `curl`, `lsof`, `ca-certificates`).
- Install any missing system dependencies automatically (requires root or passwordless sudo).
- Set up secure permissions (`0700` for directories, `0600` for files).
- Create a desktop launcher shortcut at `~/Desktop/watsup.desktop` and register it in the desktop menus.
- Build production Node.js modules using `npm ci` only if they are missing or corrupt.
- Start the WhatsApp socket daemon and the GUI.

### 2. Updating an Existing Install (Session Preservation)

> [!WARNING]
> Running the clean install command (`rm -rf ~/watsup ...`) on an existing installation will delete your WhatsApp pairing credentials and force you to re-scan the QR code.
> 
> To update the application without losing your pairing session, **never run `rm -rf`**. Instead, run:

```bash
cd ~/watsup && git pull --ff-only && ./launch.sh
```

This preserves the `auth_info_baileys`, `contacts_cache.json`, and `.watsup_ipc_token` files, ensuring a seamless update experience.

---

## 🚀 Running the Application

### Step 1: Start the Background Engine

Run the Node.js service first to handle socket layers and generate the pairing QR code.

```bash
node engine.js
```

-   **Pairing (First Run Only)**: The engine will generate an ANSI QR code directly inside your terminal window, and write a high-contrast graphic `qr.png` file to disk.
-   **Scan with Phone**: Open WhatsApp on your phone ➔ **Linked Devices** ➔ **Link a Device** and scan the QR code.
-   **Auto-Reconnect**: Once authenticated, credentials are saved locally in `./auth_info_baileys/`. Subsequent launches will log in automatically without scanning.

### Step 2: Start the Desktop GUI

Once the engine is initialized and running in the background, open a terminal **inside your RDP or X11 desktop environment** and run the GUI:

```bash
python3 ui.py
```

---

## 🧪 Running Unit Tests

The project includes offline-capable unit tests for both Node.js and Python environments:

```bash
# Run Node.js engine unit tests only
npm run test:node

# Run Python UI unit tests only (with bytecode disabled)
npm run test:python

# Run all project tests sequentially
npm run test:all
```

---

## 🖥️ Operating the Dashboard

1.  **Check Connection**: The status card at the top will automatically show `CONNECTED` in green and display the linked phone details.
2.  **Select Recipient**: Click the recipient field. Your synced WhatsApp contacts (marked with `👤 `) and participated Groups (marked with `👥 [Group] `) will populate the dropdown automatically. Start typing to filter, or type any international phone number directly to use manual entry.
3.  **Files Queue**: Click **Add Files...** to select one or multiple files of any size (up to 2GB each). They will appear inside the embedded, scrollable queue table with their individual sizes.
4.  **Manage Queue**: To remove an unwanted file before sending, select it in the table and click the red **Remove Selected** button.
5.  **Stream**: Click the purple **Send via local disk stream** button. The files will stream sequentially in the background while the progress bar and logs console update in real time. Failed files are retained in the queue for convenient retries.
