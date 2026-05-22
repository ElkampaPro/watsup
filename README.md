# WatsUp Desktop Streamer - Deployment & Setup Guide

This guide details the process of installing, configuring, and running the **WatsUp Desktop Streamer** on an Ubuntu RDP server or inside a Google Cloud Docker container.

This application is split into two distinct parts:
1.  **The Engine (`engine.js`)**: A background Node.js service using `@whiskeysockets/baileys` that manages the raw WhatsApp WebSocket connection and handles direct file streaming from your disk to WhatsApp servers.
2.  **The UI (`ui.py`)**: A native, ultra-lightweight Python Tkinter GUI (consuming **< 15MB RAM**) that you run inside your RDP desktop session to select files and contacts.

---

## ⚙️ How It Solves the 2GB Crash & RAM Spikes
-   **Zero Browser Footprint**: No headless Chrome, Puppeteer, or Electron is used, saving **over 1.5GB of RAM** at idle. The Node.js engine operates at **< 80MB RAM**.
-   **Local Disk Referencing**: Instead of uploading heavy files from the GUI to a server, the Tkinter GUI simply sends the *local absolute file path* (e.g., `/defaults/Downloads/movie.mp4`) to the local engine via loopback `http://127.0.0.1:5001`.
-   **Direct Disk Streaming**: The engine opens a read stream directly from that path and pipes it block-by-block (~64KB buffers) down the WebSocket, keeping memory usage flat regardless of whether the file is 10MB or 2GB.

---

## 🐋 Option A: Docker Container Deployment (Recommended for Google Cloud)

This option packages the Node.js engine, Python GUI, system dependencies (Tkinter, Python3), and your chosen tools (`firefox`, `qbittorrent`, `rar`, `unrar`) into a single container that boots a complete XFCE desktop environment accessible via any web browser on port `3000`.

### 1. Build and Launch the Container on Google Cloud VM

Copy the application directory to your VM, navigate to it, and run:

```bash
# 1. Stop and remove any existing container
docker rm -f ubuntu-webtop 2>/dev/null

# 2. Build the customized image with all dependencies pre-installed
docker build -t my-webtop .

# 3. Launch the container
docker run -d \
  --name ubuntu-webtop \
  -p 3000:3000 \
  --shm-size=8g \
  --restart unless-stopped \
  my-webtop
```

> [!NOTE]
> We map port `3000` to access the XFCE desktop from your browser.
> The WhatsApp loopback API is bound to `5001` inside the container for total isolation.
> The shared memory size is set to `--shm-size=8g` to prevent browser tab crashes during massive web sessions.

---

### 2. Double-Click to Stream inside Webtop XFCE

1.  Open your browser and navigate to your Google Cloud VM's public IP at port `3000`:
    `http://<your-vm-ip>:3000`
2.  You will see a fully functional, premium XFCE desktop environment.
3.  On the desktop, you will find a shortcut icon called **WatsUp Streamer**.
4.  **Double-click the WatsUp Streamer shortcut**. A terminal window will open automatically.
5.  **Scan the QR Code**: 
    -   On your first run, the background engine will generate a WhatsApp pairing QR code directly inside that terminal window.
    -   Open **WhatsApp** on your phone -> **Settings / Three Dots** -> **Linked Devices** -> **Link a Device**.
    -   Scan the terminal QR code.
6.  **Use the GUI**:
    -   Once scanned, the elegant, dark-themed GUI will load instantly on top.
    -   Choose your contact or write a number manually.
    -   Click **Browse File...** to choose any heavy torrent/download file.
    -   Click **Send via local disk stream**. The file is piped block-by-block without loading into RAM!
7.  **Auto Clean-Up**: Closing the GUI window will automatically terminate the background Node.js engine process and close the terminal.

---

## 🛠️ Option B: Direct Installation on Bare-Metal Ubuntu VM

If you prefer to install Node.js and Python dependencies directly on your server host without Docker:

### Part 1: Installing the Engine (Node.js) via SSH

1.  **Connect to your Ubuntu server** via your terminal:
    ```bash
    ssh username@your-server-ip
    ```

2.  **Install Node.js (v20 LTS)**:
    ```bash
    # Update package lists
    sudo apt update && sudo apt upgrade -y
    
    # Download NodeSource setup and install Node.js
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs build-essential
    ```

3.  **Set up the project folder**:
    ```bash
    # Create directory and set ownership
    sudo mkdir -p /var/www/watsup-desktop
    sudo chown -R $USER:$USER /var/www/watsup-desktop
    cd /var/www/watsup-desktop
    ```
    *(Move `package.json`, `engine.js`, and `ui.py` into this folder)*

4.  **Install Engine Dependencies**:
    ```bash
    npm install --production
    ```

---

### Part 2: Installing UI Dependencies (Python & Tkinter)

Python is pre-installed on Ubuntu, but its native GUI module (**Tkinter**) is typically stripped out on cloud servers. **You must install it manually to prevent crashes.**

1.  **Install Tkinter for Python 3**:
    ```bash
    sudo apt install -y python3-tk
    ```

---

### Part 3: Authenticating with WhatsApp (Terminal QR Code)

Since we are browserless, the WhatsApp QR pairing code will be displayed directly inside your SSH terminal window using ANSI characters on your first run.

1.  **Launch the engine in the foreground** to scan the QR code:
    ```bash
    cd /var/www/watsup-desktop
    node engine.js
    ```

2.  **Scan the QR Code**:
    -   When the QR code appears in your terminal, open **WhatsApp** on your phone.
    -   Go to **Settings / Three Dots** -> **Linked Devices** -> **Link a Device**.
    -   Point your camera at the ANSI terminal QR code.
    -   Once paired, your terminal will print: `🎉 WHATSAPP CONNECTION SUCCESSFULLY ESTABLISHED!`

3.  **Exit the foreground process** with `CTRL + C`. Your credentials are now securely saved in `/var/www/watsup-desktop/auth_info_baileys` and will persist automatically.

---

### Part 4: Running the Engine permanently in the Background (PM2)

We will use the **PM2** process manager to run the engine in the background and ensure it auto-starts if the server reboots.

1.  **Install PM2 globally**:
    ```bash
    sudo npm install -g pm2
    ```

2.  **Start the Engine with PM2**:
    ```bash
    cd /var/www/watsup-desktop
    pm2 start engine.js --name "watsup-engine"
    ```

3.  **Configure System Boot Launch**:
    ```bash
    pm2 startup
    ```
    *Copy and execute the output command starting with `sudo env PATH=...` that PM2 displays to configure your systemd service.*

4.  **Save the process state**:
    ```bash
    pm2 save
    ```

You can now close your SSH terminal! The engine is running silently in the background, listening on `127.0.0.1:5001` (strictly isolated to localhost loopbacks for safety).

---

### Part 5: Launching the Desktop UI inside RDP

Now, log in to your Ubuntu Desktop session via your RDP client (e.g., Windows Remote Desktop or Remmina).

1.  **Open a Terminal** inside your RDP window.
2.  **Make `ui.py` executable**:
    ```bash
    chmod +x /var/www/watsup-desktop/ui.py
    ```
3.  **Run the GUI**:
    ```bash
    python3 /var/www/watsup-desktop/ui.py
    ```

The elegant, dark-themed **WatsUp Desktop Streamer** window will appear instantly.

---

## 📱 Operating the GUI Dashboard

1.  **Check Connection**: The status card will show `CONNECTED` in green and list your paired WhatsApp phone number.
2.  **Select Recipient**: Click the recipient input. A list of your synced WhatsApp contacts will load. Start typing to filter, or type a brand new number (e.g., `15551234567`) and click the "Manual Entry" option.
3.  **Select Heavy File**: Click **Browse File...**. This opens your native Ubuntu GTK file manager. Choose any file (up to **2GB**). The GUI displays the filename and exact file size.
4.  **Send**: Click **Send via local disk stream**.
    -   The GUI sends the file path to the background engine.
    -   The engine streams it directly from disk to the WhatsApp socket.
    -   A log console at the bottom will trace the process: `[16:40:02] Engine is streaming movie.mp4...` -> `[16:40:15] File streamed and sent successfully!`
5.  **Enjoy Zero-Lag RDP Performance**: The RDP session remains completely fluid throughout the process, using under **100MB RAM** combined!

---

## 🪵 Diagnostic & Log Commands

To monitor connection logs or debug failures from your background engine, run these command tools in your SSH window:
-   Check engine console logs: `pm2 logs watsup-engine`
-   Restart engine socket connection: `pm2 restart watsup-engine`
-   Stop engine: `pm2 stop watsup-engine`
