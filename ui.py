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
        self.root.geometry("580x560")
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
        self.selected_file_path = ""
        self.connection_status = "offline"
        self.polling_active = True
        
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
        
        style.configure('TLabel', background=self.bg_color, foreground=self.text_color, font=("Helvetica", 10))
        style.configure('CardLabel.TLabel', background=self.card_color, foreground=self.text_color, font=("Helvetica", 10))
        style.configure('Title.TLabel', background=self.card_color, foreground=self.text_color, font=("Helvetica", 13, "bold"))
        style.configure('AppHeader.TLabel', background=self.bg_color, foreground="#818cf8", font=("Helvetica", 16, "bold"))
        
        # Status configurations
        style.configure('Offline.TLabel', background=self.card_color, foreground=self.danger_color, font=("Helvetica", 10, "bold"))
        style.configure('Online.TLabel', background=self.card_color, foreground=self.success_color, font=("Helvetica", 10, "bold"))
        
        # Styled custom buttons
        style.configure('TButton', font=("Helvetica", 10, "bold"), padding=6, background=self.accent_color, foreground="#ffffff", borderwidth=0)
        style.map('TButton',
                  background=[('active', '#9333ea'), ('disabled', '#4b5563')],
                  foreground=[('active', '#ffffff'), ('disabled', '#9ca3af')])
                  
        style.configure('Browse.TButton', font=("Helvetica", 9, "bold"), padding=4, background="#4b5563", foreground="#ffffff", borderwidth=0)
        style.map('Browse.TButton', background=[('active', '#374151')])

    def create_widgets(self):
        # 1. Main Header Branding
        header_frame = ttk.Frame(self.root)
        header_frame.pack(fill="x", padx=25, pady=(20, 10))
        
        header_label = ttk.Label(header_frame, text=" WatsUp Desktop Streamer", style="AppHeader.TLabel")
        header_label.pack(side="left")
        
        sub_label = ttk.Label(header_frame, text="Ubuntu RDP Pipeline", foreground="#9ca3af", font=("Helvetica", 9, "italic"))
        sub_label.pack(side="right", pady=5)

        # 2. Connection Status Card
        status_card = ttk.Frame(self.root, style="Card.TFrame")
        status_card.pack(fill="x", padx=20, pady=10)
        
        inner_status = ttk.Frame(status_card, background=self.card_color)
        inner_status.pack(fill="x", padx=15, pady=15)
        
        ttk.Label(inner_status, text="WhatsApp Session Status:", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        self.status_val_label = ttk.Label(inner_status, text="ENGINE OFFLINE", style="Offline.TLabel")
        self.status_val_label.grid(row=0, column=1, sticky="w", padx=10)
        
        self.session_user_label = ttk.Label(inner_status, text="No connected session details found.", style="CardLabel.TLabel", foreground="#9ca3af")
        self.session_user_label.grid(row=1, column=0, columnspan=2, sticky="w", pady=(8, 0))

        # 3. Content Sender Control Board
        control_board = ttk.Frame(self.root, style="Card.TFrame")
        control_board.pack(fill="both", expand=True, padx=20, pady=10)
        
        inner_board = ttk.Frame(control_board, background=self.card_color)
        inner_board.pack(fill="both", expand=True, padx=20, pady=20)
        
        # Step 1: Destination Selection
        ttk.Label(inner_board, text="1. CHOOSE RECIPIENT OR MANUAL NUMBER", style="Title.TLabel").pack(anchor="w")
        
        self.recipient_var = tk.StringVar()
        self.recipient_combobox = ttk.Combobox(inner_board, textvariable=self.recipient_var, font=("Helvetica", 10))
        self.recipient_combobox.pack(fill="x", pady=(8, 20))
        self.recipient_combobox.bind("<KeyRelease>", self.filter_contacts)
        self.recipient_combobox.bind("<<ComboboxSelected>>", self.validate_inputs)
        
        # Step 2: File Browser Picker
        ttk.Label(inner_board, text="2. CHOOSE HEAVY FILE FOR LOCAL STREAMING (MAX 2GB)", style="Title.TLabel").pack(anchor="w")
        
        file_picker_frame = ttk.Frame(inner_board, background=self.card_color)
        file_picker_frame.pack(fill="x", pady=8)
        
        self.browse_btn = ttk.Button(file_picker_frame, text="Browse File...", style="Browse.TButton", command=self.open_file_dialog)
        self.browse_btn.pack(side="left")
        
        self.file_details_label = ttk.Label(file_picker_frame, text="No file selected.", style="CardLabel.TLabel", foreground="#9ca3af")
        self.file_details_label.pack(side="left", padx=15, fill="x", expand=True)
        
        # Step 3: Trigger Button & Progress indicators
        self.send_btn = ttk.Button(inner_board, text="Send via local disk stream", state="disabled", command=self.initiate_transmission)
        self.send_btn.pack(fill="x", pady=(25, 15))
        
        # Info Logger Pane
        self.logger_box = tk.Text(inner_board, height=4, bg="#111827", fg="#f3f4f6", insertbackground="#ffffff",
                                  font=("Courier", 9), relief="solid", borderwidth=1, state="disabled")
        self.logger_box.pack(fill="x")
        
        # Footer watermark
        ttk.Label(self.root, text="Zero-Browser Engine Core  •  Flat RAM Pipeline", foreground="#6b7280", font=("Helvetica", 8)).pack(side="bottom", pady=10)

    # ==========================================
    # INPUT ACTIONS & HANDLERS
    # ==========================================
    
    def open_file_dialog(self):
        # Open native Ubuntu file picker dialog
        file_path = filedialog.askopenfilename(
            parent=self.root,
            title="Select Document/Video to Stream (Max 2GB)"
        )
        if file_path:
            self.selected_file_path = file_path
            file_size_formatted = self.format_bytes(os.path.getsize(file_path))
            file_name = os.path.basename(file_path)
            
            self.file_details_label.config(
                text=f"{file_name} ({file_size_formatted})",
                foreground=self.text_color
            )
            self.log_message(f"Selected file: {file_path}")
        else:
            self.selected_file_path = ""
            self.file_details_label.config(
                text="No file selected.",
                foreground="#9ca3af"
            )
            
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
        has_file = self.selected_file_path != ""
        is_connected = self.connection_status == "connected"
        
        if has_recipient and has_file and is_connected:
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
        while self.polling_active:
            self.check_engine_status()
            time.sleep(2)  # Non-intrusive status poll frequency

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
                
                # If contacts map is empty, trigger a background sync fetch
                if not self.contacts_data:
                    threading.Thread(target=self.fetch_contacts_list, daemon=True).start()
            elif status == "connecting":
                self.root.after(0, self.update_status_ui, "CONNECTING", "Establishing raw socket interfaces...", "Offline.TLabel")
            else:
                self.root.after(0, self.update_status_ui, "PAIRING REQUIRED", "Engine connected. Terminal scanning requested.", "Offline.TLabel")
        else:
            # Engine server is offline entirely
            self.connection_status = "offline"
            self.contacts_data = {}
            self.root.after(0, self.update_status_ui, "ENGINE OFFLINE", "Run 'node engine.js' in your terminal SSH window.", "Offline.TLabel")
            self.root.after(0, self.clear_contacts_dropdown)
            
        self.root.after(0, self.validate_inputs)

    def update_status_ui(self, status_text, detail_text, style_class):
        self.status_val_label.config(text=status_text, style=style_class)
        self.session_user_label.config(text=detail_text)

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
                    jid_number = contact["id"].split("@")[0]
                    display = f"{contact['name']} (+{jid_number})"
                    temp_map[display] = contact["id"]
                    dropdown_values.append(display)
            
            self.contacts_data = temp_map
            self.root.after(0, self.set_contacts_dropdown, dropdown_values)

    def set_contacts_dropdown(self, values):
        self.recipient_combobox['values'] = values
        self.log_message(f"Synced {len(values)} contacts successfully.")

    # ==========================================
    # FILE SEND PIPELINE
    # ==========================================

    def initiate_transmission(self):
        self.send_btn.config(state="disabled")
        self.browse_btn.config(state="disabled")
        self.recipient_combobox.config(state="disabled")
        
        self.log_message("Initiating stream pipeline...")
        
        # Execute the transmission worker on a background thread so Tkinter remains completely responsive
        threading.Thread(target=self.transmission_worker, daemon=True).start()

    def transmission_worker(self):
        recipient = self.recipient_var.get().strip()
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
            
        payload = {
            "filePath": self.selected_file_path,
            "recipient": target_jid
        }
        
        self.log_message(f"Engine is streaming {os.path.basename(self.selected_file_path)}...")
        
        # Post request to engine API endpoint
        res = self.make_api_request("/api/send", data=payload)
        
        if res.get("success", False):
            self.root.after(0, self.post_transmission_ui, True, "File streamed and sent successfully!")
        else:
            error_msg = res.get("error", "Unknown transmission error")
            self.root.after(0, self.post_transmission_ui, False, f"Upload Failed: {error_msg}")

    def post_transmission_ui(self, success, message):
        self.send_btn.config(state="normal")
        self.browse_btn.config(state="normal")
        self.recipient_combobox.config(state="normal")
        
        self.log_message(message)
        
        if success:
            messagebox.showinfo("Success", message, parent=self.root)
            # Reset UI files selection
            self.selected_file_path = ""
            self.file_details_label.config(text="No file selected.", foreground="#9ca3af")
        else:
            messagebox.showerror("Error", message, parent=self.root)
            
        self.validate_inputs()

    # ==========================================
    # LOW-LEVEL IPC API UTILITIES
    # ==========================================

    def make_api_request(self, path, data=None):
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
            # Short timeout to keep UI fluid and responsive on crashes
            with urllib.request.urlopen(req, timeout=8) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.URLError as e:
            return {"offline_flag": True, "error": str(e)}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ==========================================
    # INTERFACE UTILS
    # ==========================================

    def log_message(self, message):
        self.logger_box.config(state="normal")
        timestamp = time.strftime("[%H:%M:%S] ")
        self.logger_box.insert("end", f"{timestamp}{message}\n")
        self.logger_box.see("end")
        self.logger_box.config(state="disabled")

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
