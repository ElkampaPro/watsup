# Use LinuxServer.io Ubuntu XFCE Webtop as the base image
FROM lscr.io/linuxserver/webtop:ubuntu-xfce

# Set non-interactive mode for apt installations
ENV DEBIAN_FRONTEND=noninteractive

# Update system and install basic tools (curl)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl gnupg lsof && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js v20 LTS from NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Webtop packages, Python, and Tkinter
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        firefox \
        qbittorrent \
        rar \
        unrar \
        python3 \
        python3-tk \
        python3-pip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory for the WhatsApp Streamer app
WORKDIR /app/watsup

# Copy application files into the container
COPY package.json engine.js ui.py launch.sh watsup.desktop ./

# Install Node.js production dependencies
RUN npm install --production

# Make the launcher script executable
RUN chmod +x launch.sh

# Download a beautiful official WhatsApp icon for a premium look
RUN curl -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -fsSL -o /usr/share/pixmaps/watsup.png https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/WhatsApp.svg/512px-WhatsApp.svg.png

# Create the defaults desktop folder if it doesn't exist and copy the desktop launcher
# Also copy it to the system applications directory so it installs in the XFCE start menu!
RUN mkdir -p /defaults/Desktop && \
    cp watsup.desktop /defaults/Desktop/watsup.desktop && \
    cp watsup.desktop /usr/share/applications/watsup.desktop

# Fix ownership of the app directory so the Webtop user (abc, UID 1000)
# can read, write, and persist WhatsApp login state and contacts cache
RUN chown -R 1000:1000 /app/watsup

# Expose port 3000 for Webtop (HTTP GUI) and port 5001 for internal loopback references
EXPOSE 3000
EXPOSE 5001
