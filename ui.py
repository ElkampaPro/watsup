#!/usr/bin/env python3
"""
WatsUp Streamer - ui.py
Native, ultra-lightweight Tkinter GUI for Ubuntu RDP.
Communicates strictly with the local Node.js background engine.
Consumes < 15MB RAM. Built entirely on standard Python modules (zero pip installs).
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import urllib.request
import urllib.error
import json
import os
import threading
import time

class WatsUpUI:
    def __init__(self, root):
        self.root = root
        self.root.title("WatsUp Desktop Streamer")
        self.root.geometry("580x680")
        self.root.resizable(False, False)
        
        # Configure layout styling
        self.bg_color = "#111827"  # Deep dark background
        self.card_color = "#1f2937"  # Gray card background
        self.accent_color = "#a855f7"  # Elegant purple
        self.text_color = "#f3f4f6"  # Light gray text
        self.success_color = "#10b981"  # Emerald green
        self.danger_color = "#ef4444"  # Red
        
        self.root.configure(bg=self.bg_color)
        
        # Application data states
        self.contacts_data = {}  # Map of display_name -> raw JID
        self.selected_files = []
        self.connection_status = "offline"
        self.polling_active = True
        self.qr_popup = None
        self.qr_photo = None
        self.upload_active = False
        self.contacts_fetched = False
        
        # Custom TTK styles
        self.setup_styles()
        
        # Draw all visual containers
        self.create_widgets()
        
        # Start state check and contacts sync loops on background threads
        self.start_background_polling()

    def setup_styles(self):
        style = ttk.Style()
        style.theme_use('clam')
        
        # General window style hooks
        style.configure('TFrame', background=self.bg_color)
        style.configure('Card.TFrame', background=self.card_color, borderwidth=1, relief="solid")
        
        style.configure('TLabel', background=self.bg_color, foreground=self.text_color, font=("DejaVu Sans", 10))
        style.configure('CardLabel.TLabel', background=self.card_color, foreground=self.text_color, font=("DejaVu Sans", 10))
        style.configure('Title.TLabel', background=self.card_color, foreground=self.text_color, font=("DejaVu Sans", 12, "bold"))
        style.configure('AppHeader.TLabel', background=self.bg_color, foreground="#818cf8", font=("DejaVu Sans", 15, "bold"))
        
        # Status configurations
        style.configure('Offline.TLabel', background=self.card_color, foreground=self.danger_color, font=("DejaVu Sans", 10, "bold"))
        style.configure('Online.TLabel', background=self.card_color, foreground=self.success_color, font=("DejaVu Sans", 10, "bold"))
        
        # Styled custom buttons
        style.configure('TButton', font=("DejaVu Sans", 10, "bold"), padding=6, background=self.accent_color, foreground="#ffffff", borderwidth=0)
        style.map('TButton',
                  background=[('active', '#9333ea'), ('disabled', '#4b5563')],
                  foreground=[('active', '#ffffff'), ('disabled', '#9ca3af')])
                  
        style.configure('Browse.TButton', font=("DejaVu Sans", 9, "bold"), padding=4, background="#4b5563", foreground="#ffffff", borderwidth=0)
        style.map('Browse.TButton', background=[('active', '#374151')])
        
        style.configure('Remove.TButton', font=("DejaVu Sans", 9, "bold"), padding=4, background=self.danger_color, foreground="#ffffff", borderwidth=0)
        style.map('Remove.TButton', background=[('active', '#dc2626'), ('disabled', '#4b5563')])

        # Custom Treeview styles for the dark theme
        style.configure("Treeview",
                        background=self.card_color,
                        foreground=self.text_color,
                        rowheight=25,
                        fieldbackground=self.card_color,
                        borderwidth=0,
                        font=("DejaVu Sans", 9))
        style.map("Treeview",
                  background=[("selected", self.accent_color)],
                  foreground=[("selected", "#ffffff")])
        style.configure("Treeview.Heading",
                        background="#374151",
                        foreground=self.text_color,
                        font=("DejaVu Sans", 9, "bold"))

        # Custom Progressbar styling (Success emerald green)
        style.configure("TProgressbar",
                        troughcolor=self.card_color,
                        background=self.success_color,
                        thickness=12,
                        lightcolor=self.success_color,
                        darkcolor=self.success_color,
                        borderwidth=0)

    def create_widgets(self):
        # 1. Main Header Branding
        header_frame = ttk.Frame(self.root)
        header_frame.pack(fill="x", padx=25, pady=(20, 10))
        
        header_label = ttk.Label(header_frame, text=" WatsUp Desktop Streamer", style="AppHeader.TLabel")
        header_label.pack(side="left")
        
        sub_label = ttk.Label(header_frame, text="Ubuntu RDP Pipeline", foreground="#9ca3af", font=("DejaVu Sans", 9, "italic"))
        sub_label.pack(side="right", pady=5)

        # 2. Connection Status Card
        status_card = ttk.Frame(self.root, style="Card.TFrame")
        status_card.pack(fill="x", padx=20, pady=10)
        
        inner_status = tk.Frame(status_card, background=self.card_color)
        inner_status.pack(fill="x", padx=15, pady=15)
        
        ttk.Label(inner_status, text="WhatsApp Session Status:", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        self.status_val_label = ttk.Label(inner_status, text="ENGINE OFFLINE", style="Offline.TLabel")
        self.status_val_label.grid(row=0, column=1, sticky="w", padx=10)
        
        self.session_user_label = ttk.Label(inner_status, text="No connected session details found.", style="CardLabel.TLabel", foreground="#9ca3af")
        self.session_user_label.grid(row=1, column=0, columnspan=2, sticky="w", pady=(8, 0))

        # 3. Content Sender Control Board
        control_board = ttk.Frame(self.root, style="Card.TFrame")
        control_board.pack(fill="both", expand=True, padx=20, pady=10)
        
        inner_board = tk.Frame(control_board, background=self.card_color)
        inner_board.pack(fill="both", expand=True, padx=20, pady=20)
        
        # Step 1: Destination Selection
        ttk.Label(inner_board, text="1. CHOOSE RECIPIENT OR MANUAL NUMBER", style="Title.TLabel").pack(anchor="w")
        
        self.recipient_var = tk.StringVar()
        self.recipient_combobox = ttk.Combobox(inner_board, textvariable=self.recipient_var, font=("DejaVu Sans", 10))
        self.recipient_combobox.pack(fill="x", pady=(8, 20))
        self.recipient_combobox.bind("<KeyRelease>", self.filter_contacts)
        self.recipient_combobox.bind("<<ComboboxSelected>>", self.validate_inputs)
        
        # Step 2: Files Queue
        ttk.Label(inner_board, text="2. FILES QUEUE (SELECT & MANAGE PIPELINE)", style="Title.TLabel").pack(anchor="w", pady=(0, 5))
        
        # Grid container for Treeview table and Action buttons
        queue_container = tk.Frame(inner_board, background=self.card_color)
        queue_container.pack(fill="x", pady=5)
        
        # Treeview Scrollbar
        scroll_y = ttk.Scrollbar(queue_container, orient="vertical")
        
        # Treeview Table
        self.queue_tree = ttk.Treeview(queue_container, columns=("name", "size"), show="headings", height=4, yscrollcommand=scroll_y.set)
        scroll_y.config(command=self.queue_tree.yview)
        
        self.queue_tree.heading("name", text="File Name")
        self.queue_tree.heading("size", text="Size")
        
        self.queue_tree.column("name", width=340, anchor="w")
        self.queue_tree.column("size", width=120, anchor="e")
        
        self.queue_tree.pack(side="left", fill="x", expand=True)
        scroll_y.pack(side="left", fill="y")
        
        # Action Buttons container (Add / Remove)
        action_btn_frame = tk.Frame(inner_board, background=self.card_color)
        action_btn_frame.pack(fill="x", pady=(5, 15))
        
        self.browse_btn = ttk.Button(action_btn_frame, text="Add Files...", style="Browse.TButton", command=self.open_file_dialog)
        self.browse_btn.pack(side="left")
        
        self.remove_btn = ttk.Button(action_btn_frame, text="Remove Selected", style="Remove.TButton", state="disabled", command=self.remove_selected_file)
        self.remove_btn.pack(side="left", padx=10)
        
        self.queue_tree.bind("<<TreeviewSelect>>", self.on_tree_select)
        
        self.file_details_label = ttk.Label(action_btn_frame, text="0 files selected (0 Bytes)", style="CardLabel.TLabel", foreground="#9ca3af")
        self.file_details_label.pack(side="right", padx=10)
        
        # Step 3: Trigger Button & Progress indicators
        self.send_btn = ttk.Button(inner_board, text="Send via local disk stream", state="disabled", command=self.initiate_transmission)
        self.send_btn.pack(fill="x", pady=(25, 10))
        
        # Progress indicator panel
        self.progress_frame = tk.Frame(inner_board, background=self.card_color)
        self.progress_frame.pack(fill="x", pady=(0, 15))
        
        # Dynamic golden-yellow splitting notification banner (hidden by default)
        self.splitting_banner = tk.Label(
            self.progress_frame,
            text="",
            bg="#eab308",  # Premium amber/yellow
            fg="#111827",  # Deep dark contrast text
            font=("DejaVu Sans", 9, "bold"),
            pady=6,
            relief="flat"
        )
        
        # Row 1 of progress panel: Labels side-by-side
        labels_row = tk.Frame(self.progress_frame, background=self.card_color)
        labels_row.pack(fill="x", pady=(0, 5))
        
        self.progress_status_label = ttk.Label(labels_row, text="Upload Progress: Idle", style="CardLabel.TLabel")
        self.progress_status_label.pack(side="left")
        
        self.progress_percent_label = ttk.Label(labels_row, text="0%", style="CardLabel.TLabel", foreground=self.accent_color, font=("Helvetica", 10, "bold"))
        self.progress_percent_label.pack(side="right")
        
        # Row 2 of progress panel: Full-width progress bar
        self.progress_bar = ttk.Progressbar(self.progress_frame, orient="horizontal", mode="determinate")
        self.progress_bar.pack(fill="x", expand=True)
        
        # Info Logger Pane
        self.logger_box = tk.Text(inner_board, height=4, bg="#111827", fg="#f3f4f6", insertbackground="#ffffff",
                                  font=("Courier", 9), relief="solid", borderwidth=1, state="disabled")
        self.logger_box.pack(fill="x")
        
        # Footer watermark
        ttk.Label(self.root, text="Zero-Browser Engine Core  •  Flat RAM Pipeline", foreground="#6b7280", font=("DejaVu Sans", 8)).pack(side="bottom", pady=10)

    # ==========================================
    # INPUT ACTIONS & HANDLERS
    # ==========================================
    
    def open_file_dialog(self):
        # Open native Ubuntu file picker dialog (multiple selection enabled)
        file_paths = filedialog.askopenfilenames(
            parent=self.root,
            title="Select Document(s)/Video(s) to Stream (Max 2GB per file)"
        )
        if file_paths:
            # Append new selections to the queue
            for fp in file_paths:
                if fp not in self.selected_files:
                    self.selected_files.append(fp)
                    
            self.refresh_queue_table()
            self.log_message(f"Added {len(file_paths)} files to queue.")
            
        self.validate_inputs()

    def on_tree_select(self, event):
        selected = self.queue_tree.selection()
        if selected:
            self.remove_btn.config(state="normal")
        else:
            self.remove_btn.config(state="disabled")

    def refresh_queue_table(self):
        # Clear existing items
        for item in self.queue_tree.get_children():
            self.queue_tree.delete(item)
            
        total_size = 0
        # Populate table
        for idx, fp in enumerate(self.selected_files):
            file_name = os.path.basename(fp)
            size_val = os.path.getsize(fp)
            total_size += size_val
            size_str = self.format_bytes(size_val)
            
            # Insert into Treeview
            self.queue_tree.insert("", "end", iid=str(idx), values=(file_name, size_str))
            
        # Update summary label
        formatted_total = self.format_bytes(total_size)
        if len(self.selected_files) == 0:
            self.file_details_label.config(text="0 files selected (0 Bytes)", foreground="#9ca3af")
            self.remove_btn.config(state="disabled")
        else:
            self.file_details_label.config(text=f"{len(self.selected_files)} files selected ({formatted_total})", foreground=self.text_color)

    def remove_selected_file(self):
        selected_items = self.queue_tree.selection()
        if not selected_items:
            return
            
        # We process selected indexes in descending order to avoid shift issues
        indexes_to_remove = sorted([int(item) for item in selected_items], reverse=True)
        
        for idx in indexes_to_remove:
            if idx < len(self.selected_files):
                removed_file = self.selected_files.pop(idx)
                self.log_message(f"Removed from queue: {os.path.basename(removed_file)}")
                
        self.refresh_queue_table()
        self.remove_btn.config(state="disabled")
        self.validate_inputs()

    def filter_contacts(self, event):
        # Filter dropdown values dynamically based on keyed text
        typed = self.recipient_var.get().lower()
        if not typed:
            # Empty query, restore all entries
            self.recipient_combobox['values'] = list(self.contacts_data.keys())
        else:
            matches = [name for name in self.contacts_data.keys() if typed in name.lower()]
            
            # If what they typed is numerical digits, allow a custom JID entry shortcut
            digits = "".join(filter(str.isdigit, typed))
            if len(digits) >= 6 and not any(digits in name for name in matches):
                matches.insert(0, f"Manual Entry: +{digits}")
                
            self.recipient_combobox['values'] = matches
            
        self.recipient_combobox.event_generate('<Down>')
        self.validate_inputs()

    def validate_inputs(self, event=None):
        recipient = self.recipient_var.get().strip()
        has_recipient = recipient != ""
        has_files = len(self.selected_files) > 0
        is_connected = self.connection_status == "connected"
        
        if has_recipient and has_files and is_connected:
            self.send_btn.config(state="normal")
        else:
            self.send_btn.config(state="disabled")

    # ==========================================
    # BACKGROUND LOOPS & API PROTOCOLS
    # ==========================================

    def start_background_polling(self):
        # Poll connection state in a lightweight daemon thread
        threading.Thread(target=self.poll_state_loop, daemon=True).start()
        
    def poll_state_loop(self):
        counter = 0
        while self.polling_active:
            self.check_engine_status()
            counter += 1
            
            # Fast polling (0.5s) during active upload, slow polling (2s) when idle
            if self.upload_active:
                sleep_time = 0.5
            else:
                sleep_time = 2.0
                # Only poll contacts list if we are connected AND the list has not been successfully fetched yet.
                # Once we successfully fetch the groups/contacts catalog, polling stops entirely!
                if self.connection_status == "connected" and not self.contacts_fetched and counter % 5 == 0:
                    threading.Thread(target=self.fetch_contacts_list, daemon=True).start()
            time.sleep(sleep_time)

    def check_engine_status(self):
        status_res = self.make_api_request("/api/status")
        
        if not status_res.get("offline_flag", False):
            # Engine is online!
            status = status_res.get("status", "disconnected")
            self.connection_status = status
            
            if status == "connected":
                user_info = status_res.get("userInfo", {})
                user_id = user_info.get("id", "Session").split(":")[0]
                user_name = user_info.get("name", "Device")
                
                self.root.after(0, self.update_status_ui, "CONNECTED", f"Linked Device: +{user_id} ({user_name})", "Online.TLabel")
                self.root.after(0, self.close_qr_popup)
                
                # Pre-populate self-chat contact immediately upon connection transition
                if user_id and user_id != "Session" and not self.contacts_data:
                    self.root.after(0, self.setup_default_self_contact, user_id)
                
                # Check dynamic upload progress
                upload_progress = status_res.get("uploadProgress", {})
                if upload_progress.get("active", False):
                    percentage = upload_progress.get("percentage", 0)
                    file_name = upload_progress.get("fileName", "")
                    bytes_sent = self.format_bytes(upload_progress.get("bytesSent", 0))
                    total_bytes = self.format_bytes(upload_progress.get("totalBytes", 0))
                    
                    self.upload_active = True
                    self.root.after(0, self.update_progress_ui, percentage, f"Streaming: {file_name}", f"{percentage}% ({bytes_sent}/{total_bytes})")
                else:
                    if not self.upload_active:
                        self.root.after(0, self.update_progress_ui, 0, "Upload Progress: Idle", "0%")
                
                # Use engine's groupsSynced flag to know exactly when to stop polling contacts
                groups_synced = status_res.get("groupsSynced", False)
                if groups_synced and len(self.contacts_data) >= 1:
                    self.contacts_fetched = True

                # Fetch contacts list immediately upon first connection transition
                if not self.contacts_fetched:
                    threading.Thread(target=self.fetch_contacts_list, daemon=True).start()
            elif status == "connecting":
                self.root.after(0, self.update_status_ui, "CONNECTING", "Establishing raw socket interfaces...", "Offline.TLabel")
                self.root.after(0, self.close_qr_popup)
                self.contacts_fetched = False
            else:
                self.root.after(0, self.update_status_ui, "PAIRING REQUIRED", "Engine connected. Scan the QR code in the popup.", "Offline.TLabel")
                self.contacts_fetched = False
                if status_res.get("qrAvailable", False):
                    self.root.after(0, self.show_qr_popup)
                else:
                    self.root.after(0, self.close_qr_popup)
        else:
            # Engine server is offline entirely
            self.connection_status = "offline"
            self.contacts_data = {}
            self.contacts_fetched = False
            self.root.after(0, self.update_status_ui, "ENGINE OFFLINE", "Run 'node engine.js' in your terminal SSH window.", "Offline.TLabel")
            self.root.after(0, self.clear_contacts_dropdown)
            self.root.after(0, self.close_qr_popup)
            
        self.root.after(0, self.validate_inputs)

    def update_status_ui(self, status_text, detail_text, style_class):
        self.status_val_label.config(text=status_text, style=style_class)
        self.session_user_label.config(text=detail_text)

    def show_qr_popup(self):
        if self.qr_popup is not None:
            # Already open, just update it
            self.update_qr_popup()
            return
            
        # Create a new modern dark-themed popup window
        self.qr_popup = tk.Toplevel(self.root)
        self.qr_popup.title("Scan WhatsApp QR Code")
        self.qr_popup.geometry("340x390")
        self.qr_popup.resizable(False, False)
        self.qr_popup.configure(bg=self.bg_color)
        self.qr_popup.transient(self.root) # Make it modal
        
        # Center popup relative to main window
        x = self.root.winfo_x() + (self.root.winfo_width() - 340) // 2
        y = self.root.winfo_y() + (self.root.winfo_height() - 390) // 2
        self.qr_popup.geometry(f"+{x}+{y}")
        
        # Add labels
        title = ttk.Label(self.qr_popup, text="Link Your Device", font=("Helvetica", 14, "bold"), foreground=self.text_color, background=self.bg_color)
        title.pack(pady=(15, 5))
        
        instruction = ttk.Label(self.qr_popup, text="Scan this QR code with WhatsApp on your phone\n(Linked Devices -> Link a Device)", 
                                font=("Helvetica", 9), foreground="#9ca3af", background=self.bg_color, justify="center")
        instruction.pack(pady=5)
        
        # Image canvas/label
        self.qr_img_label = tk.Label(self.qr_popup, bg=self.card_color, relief="solid", borderwidth=1, width=280, height=280)
        self.qr_img_label.pack(pady=10)
        
        # Bind close event
        def on_popup_close():
            self.qr_popup.destroy()
            self.qr_popup = None
            
        self.qr_popup.protocol("WM_DELETE_WINDOW", on_popup_close)
        
        # Load the QR image
        self.update_qr_popup()

    def update_qr_popup(self):
        if self.qr_popup is None:
            return
            
        qr_img_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qr.png")
        if os.path.exists(qr_img_path):
            try:
                # PhotoImage natively loads standard PNG images perfectly in Python 3.4+
                self.qr_photo = tk.PhotoImage(file=qr_img_path)
                self.qr_img_label.config(image=self.qr_photo, text="")
            except Exception as e:
                self.qr_img_label.config(text="Loading QR image...", image="", foreground="#9ca3af")
        else:
            self.qr_img_label.config(text="Waiting for QR code...", image="", foreground="#9ca3af")

    def close_qr_popup(self):
        if self.qr_popup is not None:
            self.qr_popup.destroy()
            self.qr_popup = None
            self.qr_photo = None

    def clear_contacts_dropdown(self):
        self.recipient_combobox['values'] = []
        self.recipient_var.set("")

    def fetch_contacts_list(self):
        contacts_res = self.make_api_request("/api/contacts")
        if isinstance(contacts_res, list):
            temp_map = {}
            dropdown_values = []
            
            for contact in contacts_res:
                if contact and "id" in contact and "name" in contact:
                    jid = contact["id"]
                    name = contact["name"]
                    jid_number = jid.split("@")[0]
                    
                    # Use Right-to-Left Mark (\u200f) to isolate LTR bracket numbers from RTL Arabic characters
                    display = f"{name} \u200f(+{jid_number})"
                    temp_map[display] = jid
                    dropdown_values.append(display)
            
            # Check if the values actually changed to prevent dropdown reset spam
            if set(self.contacts_data.keys()) != set(temp_map.keys()):
                self.contacts_data = temp_map
                self.root.after(0, self.set_contacts_dropdown, dropdown_values)

    def setup_default_self_contact(self, user_id):
        display = f"👤 [Me] Chat with Yourself \u200f(+{user_id})"
        jid = f"{user_id}@s.whatsapp.net"
        if display not in self.contacts_data:
            self.contacts_data[display] = jid
            current_values = list(self.recipient_combobox['values'])
            if display not in current_values:
                current_values.insert(0, display)
                self.recipient_combobox['values'] = current_values
            
            if not self.recipient_var.get().strip():
                self.recipient_var.set(display)
                self.validate_inputs()

    def set_contacts_dropdown(self, values):
        self.recipient_combobox['values'] = values
        # Only log to UI console if we actually have synced contacts, preventing spam
        if len(values) > 0:
            self.log_message(f"Synced {len(values)} contacts successfully.")
            
            # Default recipient selection to user's own number/self-chat contact
            current = self.recipient_var.get().strip()
            if not current or "[Me]" in current or "Chat with Yourself" in current:
                for val in values:
                    if "[Me]" in val or "Chat with Yourself" in val:
                        self.recipient_var.set(val)
                        self.validate_inputs()
                        break

    # ==========================================
    # FILE SEND PIPELINE
    # ==========================================

    def initiate_transmission(self):
        recipient = self.recipient_var.get().strip()
        self.send_btn.config(state="disabled", text="Sending... Please wait")
        self.browse_btn.config(state="disabled")
        self.recipient_combobox.config(state="disabled")
        
        self.log_message("Initiating stream pipeline...")
        self.upload_active = True # Speed up polling to 0.5s for smooth progress animation
        
        # Execute the transmission worker on a background thread so Tkinter remains completely responsive
        threading.Thread(target=self.transmission_worker, args=(recipient,), daemon=True).start()

    def show_splitting_banner(self, file_name, file_size):
        size_str = self.format_bytes(file_size)
        self.splitting_banner.config(text=f" ⚠️  [Large File] Natively splitting '{file_name}' ({size_str}) into 1.95 GB RAR parts... ")
        self.splitting_banner.pack(side="top", fill="x", pady=(0, 10))
        self.update_progress_ui(0, f"Splitting: {file_name}...", "0%")

    def hide_splitting_banner(self):
        self.splitting_banner.pack_forget()

    def split_large_file(self, filePath):
        file_size = os.path.getsize(filePath)
        limit = 1950 * 1024 * 1024  # 1.95 GB (Maximum safe limit close to 2GB WhatsApp threshold)
        if file_size <= limit:
            return [filePath], False
            
        file_name = os.path.basename(filePath)
        self.log_message(f"⚠️ [Large File Detected] Natively splitting '{file_name}' ({self.format_bytes(file_size)}) into 1.95 GB RAR parts. Please wait, zero-CPU / zero-RAM active...")
        self.root.after(0, self.show_splitting_banner, file_name, file_size)
        
        # Create temp folder inside workspace
        temp_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watsup_temp_split")
        os.makedirs(temp_dir, exist_ok=True)
        
        import shutil
        import subprocess
        rar_bin = shutil.which("rar")
        
        if rar_bin:
            self.log_message(f"Using system RAR utility for authentic split RAR volumes (-m0 zero-compression)...")
            archive_base = os.path.join(temp_dir, file_name)
            # Run RAR command: rar a -m0 -v1950M -y {archive_base} {filePath}
            cmd = [rar_bin, "a", "-m0", "-v1950M", "-y", archive_base, filePath]
            try:
                subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=300)
                
                # Retrieve all generated part files (sorted alphabetically)
                part_paths = []
                for f in sorted(os.listdir(temp_dir)):
                    if f.startswith(file_name) and f.endswith(".rar"):
                        part_paths.append(os.path.join(temp_dir, f))
                        
                if part_paths:
                    self.root.after(0, self.hide_splitting_banner)
                    return part_paths, True
            except Exception as e:
                self.log_message(f"System RAR command failed: {str(e)}. Falling back to native binary splitter...")

        # Fallback native binary splitter
        part_paths = []
        part_num = 1
        buffer_size = 10 * 1024 * 1024  # 10 MB buffer
        
        try:
            with open(filePath, 'rb') as f:
                while True:
                    # Name fallback files exactly as .part1.rar to match RAR volume conventions
                    part_name = f"{file_name}.part{part_num}.rar"
                    part_path = os.path.join(temp_dir, part_name)
                    
                    bytes_written = 0
                    with open(part_path, 'wb') as out_f:
                        while bytes_written < limit:
                            read_len = min(buffer_size, limit - bytes_written)
                            chunk = f.read(read_len)
                            if not chunk:
                                break
                            out_f.write(chunk)
                            bytes_written += len(chunk)
                            
                    if bytes_written == 0:
                        # Clean up the empty part file we created at EOF
                        if os.path.exists(part_path):
                            os.remove(part_path)
                        break
                        
                    part_paths.append(part_path)
                    self.log_message(f"Created part {part_num}: {part_name} ({self.format_bytes(bytes_written)})")
                    part_num += 1
            
            self.root.after(0, self.hide_splitting_banner)
            return part_paths, True
        except Exception as e:
            self.root.after(0, self.hide_splitting_banner)
            self.log_message(f"Error splitting file '{file_name}': {str(e)}")
            # Cleanup any partially written files
            for p in part_paths:
                if os.path.exists(p):
                    try: os.remove(p)
                    except: pass
            raise e

    def transmission_worker(self, recipient):
        target_jid = ""
        
        if recipient in self.contacts_data:
            target_jid = self.contacts_data[recipient]
        elif recipient.startswith("Manual Entry: +"):
            target_jid = recipient.replace("Manual Entry: +", "") + "@s.whatsapp.net"
        else:
            # Fallback direct string cleaning
            digits = "".join(filter(str.isdigit, recipient))
            if digits:
                target_jid = digits + "@s.whatsapp.net"
                
        if not target_jid:
            self.root.after(0, self.post_transmission_ui, False, "Invalid recipient selected.")
            return

        # Backup the list of files to process sequentially
        files_to_send = list(self.selected_files)
        total_files = len(files_to_send)
        
        self.log_message(f"Starting sequential transmission of {total_files} files...")
        success_count = 0
        
        for index, filePath in enumerate(files_to_send):
            if not os.path.exists(filePath):
                self.log_message(f"File not found: {filePath}. Skipping...")
                continue
                
            fileName = os.path.basename(filePath)
            file_num_str = f"({index + 1}/{total_files})"
            
            # Check size and split if needed
            try:
                paths_to_send, is_split = self.split_large_file(filePath)
            except Exception as e:
                self.log_message(f"Skipping '{fileName}' due to splitting failure.")
                continue
                
            split_success = True
            for part_idx, path in enumerate(paths_to_send):
                partName = os.path.basename(path)
                if is_split:
                    part_str = f" [Part {part_idx + 1}/{len(paths_to_send)}]"
                    self.log_message(f"Streaming file {index + 1} of {total_files}{part_str}: {partName}...")
                else:
                    self.log_message(f"Streaming file {index + 1} of {total_files}: {fileName}...")
                
                payload = {
                    "filePath": path,
                    "recipient": target_jid
                }
                
                # Send file to engine API with safe long timeout (30 mins per file)
                res = self.make_api_request("/api/send", data=payload, timeout=1800)
                
                if not res.get("success", False):
                    error_msg = res.get("error", "Unknown transmission error")
                    self.log_message(f"Failed to send {partName}. Error: {error_msg}")
                    split_success = False
                    break
            
            # Clean up temporary split files if we generated them
            if is_split:
                self.log_message(f"Cleaning up temporary split parts for '{fileName}'...")
                for path in paths_to_send:
                    if os.path.exists(path):
                        try: os.remove(path)
                        except: pass
                # Try to remove the temp folder if it is empty
                temp_dir = os.path.dirname(paths_to_send[0])
                if os.path.exists(temp_dir) and not os.listdir(temp_dir):
                    try: os.rmdir(temp_dir)
                    except: pass
            
            if split_success:
                success_count += 1
                self.log_message(f"Successfully sent {file_num_str}: {fileName}")
            else:
                self.log_message(f"Failed to send {file_num_str}: {fileName}")
                
        if success_count == total_files:
            self.root.after(0, self.post_transmission_ui, True, f"All {total_files} files streamed and sent successfully!")
        elif success_count > 0:
            self.root.after(0, self.post_transmission_ui, False, f"Queue completed with warnings: Sent {success_count} of {total_files} files successfully.")
        else:
            self.root.after(0, self.post_transmission_ui, False, "All file transmissions in the queue failed.")

    def post_transmission_ui(self, success, message):
        self.send_btn.config(text="Send via local disk stream")
        self.send_btn.config(state="normal")
        self.browse_btn.config(state="normal")
        self.recipient_combobox.config(state="normal")
        self.upload_active = False # Revert to slow polling (2.0s)
        
        self.log_message(message)
        
        if success:
            self.update_progress_ui(100, "Upload Completed Successfully!", "100%")
            messagebox.showinfo("Success", message, parent=self.root)
            # Reset UI files queue
            self.selected_files = []
            self.refresh_queue_table()
        else:
            self.update_progress_ui(0, "Upload Failed!", "0%")
            messagebox.showerror("Error", message, parent=self.root)
            # Reset UI files queue on critical/all failures to be safe
            self.selected_files = []
            self.refresh_queue_table()
            
        self.validate_inputs()

    def update_progress_ui(self, value, status_text, percent_text=""):
        self.progress_bar["value"] = value
        self.progress_status_label.config(text=status_text)
        self.progress_percent_label.config(text=percent_text)

    # ==========================================
    # LOW-LEVEL IPC API UTILITIES
    # ==========================================

    def make_api_request(self, path, data=None, timeout=8):
        """
        Urllib-based API interface. Completely native.
        """
        url = f"http://127.0.0.1:5001{path}"
        try:
            req_data = json.dumps(data).encode('utf-8') if data else None
            req = urllib.request.Request(
                url,
                data=req_data,
                headers={'Content-Type': 'application/json'} if data else {}
            )
            # Support dynamic timeouts (short for polling, long for streaming)
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.URLError as e:
            return {"offline_flag": True, "error": str(e)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ==========================================
    # INTERFACE UTILS
    # ==========================================

    def log_message(self, message):
        timestamp = time.strftime("[%H:%M:%S] ")
        def update_log():
            self.logger_box.config(state="normal")
            self.logger_box.insert("end", f"{timestamp}{message}\n")
            self.logger_box.see("end")
            self.logger_box.config(state="disabled")
        self.root.after(0, update_log)

    def format_bytes(self, bytes_val):
        if bytes_val == 0:
            return "0 Bytes"
        sizes = ["Bytes", "KB", "MB", "GB", "TB"]
        import math
        i = int(math.floor(math.log(bytes_val) / math.log(1024)))
        return f"{round(bytes_val / math.pow(1024, i), 2)} {sizes[i]}"

if __name__ == "__main__":
    root = tk.Tk()
    app = WatsUpUI(root)
    
    # Elegant custom window closed hook
    def on_closing():
        app.polling_active = False
        root.destroy()
        
    root.protocol("WM_DELETE_WINDOW", on_closing)
    root.mainloop()
