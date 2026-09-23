"""Lyric Studio — the standalone window.

Three steps, in the order a person thinks of them:

  1. Pick a song. The picker opens where you last were, not in Downloads.
  2. Lyrics are looked up online by themselves (BiniLyrics, then LRCLIB) and
     shown for a glance or an edit. Paste your own only if nothing is found.
  3. Choose word or syllable timing and press Generate. The file lands next to
     the song, ready for Lyrigen or any player that reads TTML or LRC.

The sync runs in a separate process (the same `lyricstudio.cli` Lyrigen uses),
so the window never freezes and Cancel really stops it.
"""
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
from tkinter import filedialog, messagebox

import customtkinter as ctk

from . import __version__, settings
from .lyrics_online import find_lyrics, read_tags

ACCENT = "#d18fa0"
ACCENT_HOVER = "#e0a3b2"
SURFACE = "#1d1a24"
CARD = "#24202d"
MUTED = "#9a92a1"
AUDIO_TYPES = [("Audio", "*.mp3 *.m4a *.opus *.ogg *.flac *.wav *.webm *.aac *.wma"), ("All files", "*.*")]
MODELS = [("tiny", "Tiny · 75 MB · fastest"), ("base", "Base · 145 MB · good default"), ("small", "Small · 480 MB · better"),
          ("medium", "Medium · 1.5 GB · strong"), ("large-v3", "Large v3 · 3 GB · best (GPU)")]
LEVELS = [("syllable", "Syllable — karaoke"), ("word", "Word")]
FORMATS = [("ttml", "TTML"), ("lrc", "LRC"), ("both", "TTML + LRC")]
LANGUAGES = [("", "Detect"), ("en", "English"), ("hi", "Hindi"), ("ur", "Urdu"), ("pa", "Punjabi"), ("ta", "Tamil"), ("te", "Telugu"),
             ("bn", "Bengali"), ("ja", "Japanese"), ("ko", "Korean"), ("zh", "Chinese"), ("es", "Spanish"), ("pt", "Portuguese"),
             ("fr", "French"), ("de", "German"), ("ar", "Arabic"), ("tr", "Turkish"), ("ru", "Russian")]


def _label(options, value):
    return next((label for key, label in options if key == value), options[0][1])


def _key(options, label):
    return next((key for key, text in options if text == label), options[0][0])


class LyricStudio(ctk.CTk):
    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("dark")
        self.prefs = settings.load()
        self.title(f"Lyric Studio {__version__}")
        self.geometry("880x820")
        self.minsize(760, 700)
        self.configure(fg_color=SURFACE)
        self.audio_path: str | None = None
        self.found: dict | None = None
        self.found_text = ""
        self.events: queue.Queue = queue.Queue()
        self.process: subprocess.Popen | None = None
        self.temp_files: list[str] = []
        self._build()
        self.after(120, self._pump)
        threading.Thread(target=self._probe_gpu, daemon=True).start()

    # -- layout ---------------------------------------------------------------

    def _card(self, title: str, subtitle: str = ""):
        card = ctk.CTkFrame(self, fg_color=CARD, corner_radius=14)
        card.pack(fill="x", padx=22, pady=(0, 14))
        head = ctk.CTkFrame(card, fg_color="transparent")
        head.pack(fill="x", padx=18, pady=(14, 6))
        ctk.CTkLabel(head, text=title, font=("Segoe UI Semibold", 15)).pack(side="left")
        if subtitle:
            ctk.CTkLabel(head, text=subtitle, text_color=MUTED, font=("Segoe UI", 11)).pack(side="left", padx=10)
        return card

    def _build(self):
        top = ctk.CTkFrame(self, fg_color="transparent")
        top.pack(fill="x", padx=22, pady=(20, 14))
        ctk.CTkLabel(top, text="Lyric Studio", font=("Segoe UI Semibold", 26)).pack(side="left")
        ctk.CTkLabel(top, text="  word- and syllable-timed lyrics, made on your computer", text_color=MUTED, font=("Segoe UI", 12)).pack(side="left", pady=(8, 0))
        self.device_chip = ctk.CTkLabel(top, text="checking…", fg_color="#302a3a", corner_radius=10, font=("Segoe UI", 11), padx=10)
        self.device_chip.pack(side="right")

        song = self._card("1  Song")
        row = ctk.CTkFrame(song, fg_color="transparent")
        row.pack(fill="x", padx=18, pady=(0, 14))
        self.song_label = ctk.CTkLabel(row, text="No song chosen yet", anchor="w", justify="left", font=("Segoe UI", 13))
        self.song_label.pack(side="left", fill="x", expand=True)
        ctk.CTkButton(row, text="Choose song…", width=140, fg_color=ACCENT, hover_color=ACCENT_HOVER, text_color="#21151d",
                      font=("Segoe UI Semibold", 13), command=self.choose_song).pack(side="right")

        lyrics = self._card("2  Lyrics", "found by themselves — edit if you like")
        bar = ctk.CTkFrame(lyrics, fg_color="transparent")
        bar.pack(fill="x", padx=18)
        ctk.CTkButton(bar, text="Clear", width=70, fg_color="#302a3a", hover_color="#3b3447", command=self.clear_lyrics).pack(side="right", padx=(6, 0))
        ctk.CTkButton(bar, text="Paste", width=70, fg_color="#302a3a", hover_color="#3b3447", command=self.paste_lyrics).pack(side="right", padx=(6, 0))
        ctk.CTkButton(bar, text="Search online", width=110, fg_color="#302a3a", hover_color="#3b3447", command=self.search_lyrics).pack(side="right")
        # Where the lyrics came from gets a row of its own: the line is long
        # ("From this song's own … · word-timed by a person — …") and must wrap
        # rather than run under the buttons.
        self.lyrics_status = ctk.CTkLabel(lyrics, text="Choose a song and its lyrics are looked up.", text_color=MUTED, anchor="w", justify="left", font=("Segoe UI", 11))
        self.lyrics_status.pack(fill="x", padx=18, pady=(6, 0))
        lyrics.bind("<Configure>", lambda event: self.lyrics_status.configure(wraplength=max(200, int((event.width - 40) / lyrics._get_widget_scaling()))))
        self.lyrics_box = ctk.CTkTextbox(lyrics, height=200, font=("Segoe UI", 13), fg_color="#1a1720", wrap="word")
        self.lyrics_box.pack(fill="x", padx=18, pady=(8, 14))

        options = self._card("3  Timing")
        grid = ctk.CTkFrame(options, fg_color="transparent")
        grid.pack(fill="x", padx=18, pady=(0, 14))
        self.level = self._option(grid, 0, "Sync", LEVELS, self.prefs["level"])
        self.model = self._option(grid, 1, "Model", MODELS, self.prefs["model"])
        self.language = self._option(grid, 2, "Language", LANGUAGES, self.prefs["language"])
        self.fmt = self._option(grid, 3, "Save as", FORMATS, self.prefs["format"])

        go = ctk.CTkFrame(self, fg_color="transparent")
        go.pack(fill="x", padx=22)
        self.progress = ctk.CTkProgressBar(go, progress_color=ACCENT, height=8)
        self.progress.set(0)
        self.progress.pack(fill="x", pady=(0, 8))
        line = ctk.CTkFrame(go, fg_color="transparent")
        line.pack(fill="x")
        self.status = ctk.CTkLabel(line, text="Ready.", anchor="w", justify="left", wraplength=560, font=("Segoe UI", 12))
        self.status.pack(side="left", fill="x", expand=True)
        self.generate_button = ctk.CTkButton(line, text="Generate synced lyrics", width=210, height=40, fg_color=ACCENT,
                                             hover_color=ACCENT_HOVER, text_color="#21151d", font=("Segoe UI Semibold", 14),
                                             command=self.generate, state="disabled")
        self.generate_button.pack(side="right")
        self.result_row = ctk.CTkFrame(self, fg_color="transparent")
        self.result_row.pack(fill="x", padx=22, pady=(10, 16))
        self.result_label = ctk.CTkLabel(self.result_row, text="", anchor="w", text_color="#9ad3bf", wraplength=680, justify="left", font=("Segoe UI", 12))
        self.result_label.pack(side="left", fill="x", expand=True)
        self.open_button = ctk.CTkButton(self.result_row, text="Show in folder", width=120, fg_color="#302a3a", hover_color="#3b3447", command=self.show_in_folder)

    def _option(self, parent, column, title, options, value):
        box = ctk.CTkFrame(parent, fg_color="transparent")
        box.grid(row=0, column=column, sticky="ew", padx=(0 if column == 0 else 10, 0))
        parent.grid_columnconfigure(column, weight=1)
        ctk.CTkLabel(box, text=title.upper(), text_color=MUTED, font=("Consolas", 10)).pack(anchor="w")
        menu = ctk.CTkOptionMenu(box, values=[label for _, label in options], fg_color="#302a3a", button_color="#3b3447",
                                 button_hover_color="#4a4257", dropdown_fg_color="#2a2533")
        menu.set(_label(options, value))
        menu.pack(fill="x", pady=(4, 0))
        menu.options = options
        return menu

    # -- actions --------------------------------------------------------------

    def _probe_gpu(self):
        try:
            from .engine import gpu_count, prepare
            prepare()
            count = gpu_count()
        except Exception:
            count = 0
        self.events.put({"event": "_gpu", "count": count})

    def choose_song(self):
        start = self.prefs.get("last_folder")
        if not start or not os.path.isdir(start):
            start = os.path.join(os.path.expanduser("~"), "Music")
        path = filedialog.askopenfilename(title="Choose a song", initialdir=start, filetypes=AUDIO_TYPES)
        if not path:
            return
        self.prefs["last_folder"] = os.path.dirname(path)
        settings.save({"last_folder": self.prefs["last_folder"]})
        self.audio_path = path
        tags = read_tags(path)
        minutes = f" · {int(tags['duration'] // 60)}:{int(tags['duration'] % 60):02d}" if tags.get("duration") else ""
        self.song_label.configure(text=f"{tags.get('title') or os.path.basename(path)}\n{tags.get('artist') or 'Unknown artist'}{minutes}")
        self.generate_button.configure(state="normal")
        self.result_label.configure(text="")
        self.open_button.pack_forget()
        existing = next((os.path.splitext(path)[0] + ext for ext in (".ttml", ".lrc", ".txt") if os.path.exists(os.path.splitext(path)[0] + ext)), None)
        self.search_lyrics(existing_file=existing)

    def search_lyrics(self, existing_file: str | None = None):
        if not self.audio_path:
            return
        self.lyrics_status.configure(text="Looking the lyrics up online…")
        path = self.audio_path

        def work():
            found = None
            try:
                if existing_file:
                    found = self._read_existing(existing_file)
                if not found:
                    found = find_lyrics(path)
            except Exception as error:
                self.events.put({"event": "_lyrics", "found": None, "error": str(error)})
                return
            self.events.put({"event": "_lyrics", "found": found})

        threading.Thread(target=work, daemon=True).start()

    def _read_existing(self, file_path: str) -> dict | None:
        from .lyrics_online import guess_language, parse_lrc, parse_ttml
        with open(file_path, encoding="utf-8", errors="replace") as handle:
            content = handle.read()
        if file_path.endswith(".ttml"):
            lines, language = parse_ttml(content)
            kind = "word" if lines and all(line.get("words") for line in lines) else "line"
        elif file_path.endswith(".lrc"):
            lines, language, kind = parse_lrc(content), None, "line"
        else:
            lines = [{"text": row.strip(), "start": None, "end": None} for row in content.splitlines() if row.strip()]
            language, kind = None, "plain"
        if not lines:
            return None
        # An earlier AI sync (here or in Lyrigen) marks its files; its timing is the model's, not a person's.
        machine = "lyrigen:alignment" in content
        return {"source": f"this song's own {os.path.basename(file_path)}", "kind": kind, "lines": lines, "machine": machine,
                "language": guess_language(" ".join(line["text"] for line in lines), language)}

    def paste_lyrics(self):
        try:
            text = self.clipboard_get()
        except Exception:
            return
        self.lyrics_box.delete("1.0", "end")
        self.lyrics_box.insert("1.0", text.strip())
        self.found = None
        self.lyrics_status.configure(text="Pasted lyrics — they will be aligned across the whole song. The Small model or larger works best.")

    def clear_lyrics(self):
        self.lyrics_box.delete("1.0", "end")
        self.found = None
        self.lyrics_status.configure(text="No lyrics — the model will transcribe the vocals itself.")

    def generate(self):
        if not self.audio_path or self.process:
            return
        level, model = _key(LEVELS, self.level.get()), _key(MODELS, self.model.get())
        language, fmt = _key(LANGUAGES, self.language.get()), _key(FORMATS, self.fmt.get())
        settings.save({"level": level, "model": model, "language": language, "format": fmt})
        text = self.lyrics_box.get("1.0", "end").strip()
        args = [sys.executable, "-m", "lyricstudio.cli", "--audio", self.audio_path, "--model", model, "--level", level]
        if language:
            args += ["--language", language]
        elif self.found and self.found.get("language"):
            args += ["--language", self.found["language"]]
        unchanged = self.found and text == self.found_text.strip()
        if unchanged and self.found["kind"] in ("word", "line"):
            handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
            json.dump(self.found["lines"], handle, ensure_ascii=False)
            handle.close()
            self.temp_files.append(handle.name)
            args += ["--lines-file", handle.name]
        elif text:
            handle = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8")
            handle.write(text)
            handle.close()
            self.temp_files.append(handle.name)
            args += ["--lyrics-file", handle.name]
        self._pending_format = fmt
        self.progress.set(0)
        self.result_label.configure(text="")
        self.open_button.pack_forget()
        self.status.configure(text="Starting…")
        self.generate_button.configure(text="Cancel", command=self.cancel, fg_color="#5a3a44", hover_color="#6b4652", text_color="#f4e9ee")
        package_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1",
               "PYTHONPATH": package_root + os.pathsep + os.environ.get("PYTHONPATH", "")}
        creation = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
                                        env=env, creationflags=creation)
        threading.Thread(target=self._read_worker, args=(self.process,), daemon=True).start()

    def _read_worker(self, process: subprocess.Popen):
        for line in process.stdout:
            line = line.strip()
            if line.startswith("{"):
                try:
                    self.events.put(json.loads(line))
                except json.JSONDecodeError:
                    pass
        process.wait()
        self.events.put({"event": "_exit", "code": process.returncode})

    def cancel(self):
        if not self.process:
            return
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"], capture_output=True)
        else:
            self.process.terminate()
        self.status.configure(text="Cancelled.")

    def _finish(self):
        self.process = None
        for path in self.temp_files:
            try:
                os.remove(path)
            except OSError:
                pass
        self.temp_files.clear()
        self.generate_button.configure(text="Generate synced lyrics", command=self.generate, fg_color=ACCENT, hover_color=ACCENT_HOVER, text_color="#21151d")

    def _save(self, result: dict):
        stem = os.path.splitext(self.audio_path)[0]
        wanted = ["ttml", "lrc"] if self._pending_format == "both" else [self._pending_format]
        existing = [f"{stem}.{ext}" for ext in wanted if os.path.exists(f"{stem}.{ext}")]
        if existing and not messagebox.askyesno("Replace lyrics?", "This song already has:\n\n" + "\n".join(os.path.basename(p) for p in existing)
                                                  + "\n\nReplace it? The old file is kept as .bak."):
            self.status.configure(text="Not saved — the existing lyric file was kept.")
            return
        saved = []
        for ext in wanted:
            target = f"{stem}.{ext}"
            if os.path.exists(target):
                shutil.copyfile(target, target + ".bak")
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(result[ext])
            saved.append(target)
        self.saved_paths = saved
        stats = result.get("syllableStats") or {}
        words = sum(len(segment["words"]) for segment in result["segments"])
        detail = f" · {stats.get('acoustic', 0)} words timed by ear, {stats.get('fallback', 0)} split by length" if stats else ""
        self.result_label.configure(text="✓ Saved " + " and ".join(os.path.basename(p) for p in saved)
                                    + f" — {words} words over {len(result['segments'])} lines, {result['level']}-timed on the {'GPU' if result['device'] == 'cuda' else 'CPU'} in {result['seconds']}s{detail}.")
        self.open_button.pack(side="right")

    def show_in_folder(self):
        path = getattr(self, "saved_paths", [None])[0]
        if path and os.name == "nt":
            subprocess.run(["explorer", "/select,", os.path.normpath(path)])

    # -- events from threads and the worker -----------------------------------

    def _pump(self):
        try:
            while True:
                event = self.events.get_nowait()
                kind = event.get("event")
                if kind == "_gpu":
                    self.device_chip.configure(text="GPU ready" if event["count"] else "CPU", fg_color="#2f4a3f" if event["count"] else "#302a3a")
                elif kind == "_lyrics":
                    self._show_lyrics(event.get("found"), event.get("error"))
                elif kind == "status":
                    self.status.configure(text=event.get("message", ""))
                elif kind == "progress":
                    self.progress.set(float(event.get("percent", 0)) / 100)
                elif kind == "device":
                    if event.get("note"):
                        self.status.configure(text=event["note"])
                    self.device_chip.configure(text="Running on GPU" if event.get("device") == "cuda" else "Running on CPU")
                elif kind == "result":
                    self.progress.set(1)
                    self.status.configure(text="Done.")
                    self._save(event)
                elif kind == "error":
                    self.status.configure(text="✕ " + event.get("message", "Something went wrong."))
                elif kind == "_exit":
                    self._finish()
        except queue.Empty:
            pass
        self.after(120, self._pump)

    def _show_lyrics(self, found: dict | None, error: str | None = None):
        self.found = found
        self.lyrics_box.delete("1.0", "end")
        if not found:
            self.found_text = ""
            self.lyrics_status.configure(text=("Lookup failed: " + error) if error else "Nothing found online. Paste the lyrics, or leave it empty and the model will transcribe.")
            return
        text = "\n".join(line["text"] for line in found["lines"])
        self.found_text = text
        self.lyrics_box.insert("1.0", text)
        timed_by = "an earlier AI sync" if found.get("machine") else "a person"
        kind = {"word": f"word-timed by {timed_by} — only syllables left to do", "line": "line-timed — each line is aligned in its own moment",
                "plain": "plain text — aligned across the whole song"}[found["kind"]]
        self.lyrics_status.configure(text=f"From {found['source']} · {len(found['lines'])} lines · {kind}")


def main():
    app = LyricStudio()
    app.mainloop()


if __name__ == "__main__":
    main()
