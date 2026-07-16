# Use LinuxServer.io Ubuntu XFCE Webtop as the base image
# Constraint: Base image is specified by tag rather than exact digest (sha256), and apt packages are not version-pinned.
# Consequently, builds are not fully reproducible.
FROM lscr.io/linuxserver/webtop:ubuntu-xfce

# Set non-interactive mode for apt installations
ENV DEBIAN_FRONTEND=noninteractive

# Update system and install basic tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl gnupg lsof && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js v20 LTS securely using standard repository GPG keys (No curl | bash)
RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/keyrings/nodesource.list && \
    mv /etc/apt/keyrings/nodesource.list /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Python and Tkinter dependencies
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

# Install Python drag-and-drop package pinned to a specific version (0.4.2)
RUN pip3 install --no-cache-dir tkinterdnd2==0.4.2 --break-system-packages

# Copy only package descriptors to cache npm dependency layers
COPY package.json package-lock.json ./

# Install Node.js production dependencies strictly via npm ci
RUN npm ci --omit=dev

# Copy application source code
COPY engine.js secure_fs.js ipc_security.js logger.js jid_utils.js ui.py api_client.py file_splitter.py transmission_helper.py launch.sh watsup.desktop watsup.png ./

# Make the launcher script executable and apply safe permissions
RUN chmod +x launch.sh

# Create the defaults desktop folder if it doesn't exist and copy the desktop launcher
RUN mkdir -p /defaults/Desktop && \
    cp watsup.desktop /defaults/Desktop/watsup.desktop && \
    cp watsup.desktop /usr/share/applications/watsup.desktop

# Fix ownership of the app directory so the Webtop user (abc, UID 1000)
# can read, write, and persist WhatsApp login state and contacts cache
RUN chown -R 1000:1000 /app/watsup

# Expose port 3000 for Webtop (HTTP GUI) and port 5001 for internal loopback references
EXPOSE 3000
EXPOSE 5001
