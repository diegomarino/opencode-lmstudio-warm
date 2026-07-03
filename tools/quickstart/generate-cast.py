#!/usr/bin/env python3
"""Generate tools/quickstart/quickstart.cast (asciicast v2) for the README demo GIF.

The demo is scripted, not screen-recorded, so it stays reproducible and free
of machine-specific noise — but every output line is captured verbatim from a
real run on macOS/Apple Silicon (opencode v1.17.10, LM Studio with two local
models). The ~5 s spinner before the first response stands in for the real
~11 s cold model load (opencode prints nothing while it waits; the spinner
visualizes the plugin's background `lms load`).

Run from the repo root:
  python3 tools/quickstart/generate-cast.py
  agg --font-size 16 tools/quickstart/quickstart.cast docs/quickstart.gif
  python3 tools/quickstart/add-progress-bar.py docs/quickstart.gif
  gifsicle -O3 --colors 256 --batch docs/quickstart.gif
"""

import json
import random
import sys

random.seed(42)  # deterministic timings → stable diff on regeneration

WIDTH, HEIGHT = 110, 24

GREY = "\x1b[90m"
BOLD = "\x1b[1m"
CYAN = "\x1b[36m"
GREEN = "\x1b[32m"
RESET = "\x1b[0m"
PROMPT = f"\x1b[1;32m$\x1b[0m "

events = []
t = 0.0


def out(delay, data):
    global t
    t += delay
    events.append([round(t, 3), "o", data])


def type_text(text, cps_delay=0.045):
    for ch in text:
        out(cps_delay + random.uniform(-0.02, 0.04), ch)


def prompt():
    out(0.4, PROMPT)


def enter():
    out(0.15, "\r\n")


def clack(symbol, text, color=CYAN):
    out(0.28, f"{GREY}│{RESET}\r\n{color}{symbol}{RESET}  {text}\r\n")


# ── Scene 1: install ─────────────────────────────────────────────────────────
prompt()
type_text("opencode plugin -g opencode-lmstudio-warm")
enter()

out(0.5, f"{GREY}┌{RESET}  Install plugin opencode-lmstudio-warm\r\n")
out(0.2, f"{GREY}│{RESET}\r\n")
spinner = "◒◐◓◑"  # ◒◐◓◑ — the real clack spinner frames
for i in range(18):
    dots = "." * ((i // 5) % 4)
    out(0.08, f"\r\x1b[2K{CYAN}{spinner[i % 4]}{RESET}  Installing plugin package{dots}")
out(0.1, "\r\x1b[2K")
out(0.0, f"{CYAN}◇{RESET}  Plugin package ready\r\n")
clack("◇", "Detected server target")
clack("◇", "Plugin config updated")
clack("●", "Added to ~/.config/opencode/opencode.jsonc", GREY)
clack("◆", f"{BOLD}Installed opencode-lmstudio-warm{RESET}", GREEN)
clack("●", "Scope: global (~/.config/opencode)", GREY)
out(0.28, f"{GREY}│{RESET}\r\n{GREY}└{RESET}  Done\r\n")

# ── Scene 2: LM Studio is cold ───────────────────────────────────────────────
out(0.9, "")
prompt()
type_text("lms ps")
enter()
out(0.35, "\r\nNo models are currently loaded.\r\n")

# ── Scene 3: first request warms the model before it leaves opencode ─────────
out(1.2, "")
prompt()
type_text(f"{GREY}# first request — the plugin loads the model BEFORE the request leaves{RESET}", 0.028)
enter()
prompt()
type_text('opencode run "Reply with exactly: Hello from a pre-warmed model!"')
enter()

out(0.8, f"\r\n{GREY}> build · qwen/qwen3.6-35b-a3b{RESET}\r\n\r\n")
# Cold load happens here (~11 s real, compressed). opencode itself prints
# nothing while it waits (verified on a real TTY); this ephemeral spinner
# visualizes the plugin's background `lms load` step — wording and the
# "in 7s" figure come straight from ~/.cache/opencode/lmstudio-warm.log.
SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
for i in range(50):
    out(0.09, f"\r\x1b[2K{GREY}{SPIN[i % 10]} lmstudio-warm: loading qwen/qwen3.6-35b-a3b ...{RESET}")
out(0.15, f"\r\x1b[2K{GREY}✓ lmstudio-warm: loaded qwen/qwen3.6-35b-a3b in 7s{RESET}")
out(1.0, "\r\x1b[2K")
for ch in "Hello from a pre-warmed model!":
    out(0.018, ch)
out(0.0, "\r\n")

# ── Scene 4: both models resident, no TTL ────────────────────────────────────
out(1.4, "")
prompt()
type_text(f"lms ps   {GREY}# main + small model resident — no TTL{RESET}", 0.035)
enter()
out(0.4, "\r\n")
out(
    0.0,
    f"{BOLD}IDENTIFIER              MODEL                   STATUS    SIZE        CONTEXT    PARALLEL    DEVICE    TTL{RESET}\r\n"
    "qwen/qwen3.6-35b-a3b    qwen/qwen3.6-35b-a3b    IDLE      20.43 GB    204800     4           Local\r\n"
    "qwen2.5-7b-instruct     qwen2.5-7b-instruct     IDLE      8.10 GB     32768      4           Local\r\n",
)
out(0.5, "")
prompt()
out(3.0, "")  # hold the final frame

header = {
    "version": 2,
    "width": WIDTH,
    "height": HEIGHT,
    "title": "opencode-lmstudio-warm — quick start",
    "env": {"SHELL": "/bin/zsh", "TERM": "xterm-256color"},
}

path = sys.argv[1] if len(sys.argv) > 1 else "tools/quickstart/quickstart.cast"
with open(path, "w") as f:
    f.write(json.dumps(header) + "\n")
    for ev in events:
        f.write(json.dumps(ev) + "\n")
print(f"wrote {path} ({len(events)} events, {events[-1][0]:.1f}s)")
