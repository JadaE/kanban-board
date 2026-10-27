# Shared Kanban Board, v0.02: one shared board, live on a TV and phones

## What's new in v0.02

- **One shared board.** The Raspberry Pi now holds the "real" copy of the board. Each person's phone and the TV all show the same cards.
- **Live updates.** When someone adds, edits, moves or deletes a card, every open screen updates within about a second. Nobody has to refresh.
- **Works through hiccups.** If the Pi can't be reached, you can still open the board on the device you used last and keep working. Your changes wait in line (a "· 2 waiting" note shows next to the status dot) and sync by themselves when the Pi is back.
- **Status dot** at the top: 🟢 *Live*, 🟡 *Reconnecting…*, 🔴 *Offline*.
- **"Who are you?"** Each phone or computer asks once: Person A or Person B. No passwords. It only decides:
  - who new cards belong to by default, and
  - the small "✎ Person B" note showing who last changed a card.
  It's saved on that device only. Tap the name chip at the top to switch.
- **"Husband" is now "Person B"** everywhere. Old backups that say "husband" are converted automatically.
- **TV mode.** Open the board with `?tv=1` (the Pi does this by itself) to get big text, no mouse pointer, no buttons, no animations, and a clock. It reconnects and reloads on its own.
- **Backups.** Export/Import still work. Import now replaces the shared board for everyone. The Pi also keeps its own rolling backups (the last 30 versions, at most one every 5 minutes).
- **If two people change the same card while offline**, the most recent change wins. **A deleted card stays deleted**, even if an old offline edit to it arrives later.

## Try it on a computer

You need Node.js 18 or newer.

```bash
cd v0.02
node server.js            # then open http://localhost:8080
# TV view:                  http://localhost:8080/?tv=1   (add &theme=dark for dark mode)
```

Other devices on the same network can open `http://<this-computer's-IP>:8080`.
Opening `public/index.html` straight from disk (no server) still works like v0.01: the board is saved in that browser only.

Settings (environment variables): `PORT` (8080), `HOST` (0.0.0.0), `DATA_DIR` (./data), `BACKUPS` (30), `BACKUP_MIN_INTERVAL_S` (300), `TOMBSTONE_DAYS` (60), `PING_S` (15).

## Put it on the Raspberry Pi (TV)

Made for a **Raspberry Pi 3 (1 GB) on Ethernet** running Raspberry Pi OS with desktop (Bookworm or newer, 32- or 64-bit). It also works on a Pi 4 or 5, or over Wi-Fi.

1. Copy the `v0.02` folder to the Pi, for example with a USB stick, or from a computer with:
   `scp -r v0.02 <user>@<pi-ip>:~/kanban`
2. On the Pi, open **Terminal** and paste:
   ```bash
   cd ~/kanban && sudo ./pi/install.sh
   ```
3. When it says **Done!**, type `sudo reboot`. The TV comes up on the board by itself.

At the end, the installer prints the address phones should open. It looks like `http://192.168.1.23:8080` (Ethernet), or `http://raspberrypi.local:8080`.
**Tip:** reserve that IP for the Pi in your router (often called "DHCP reservation") so the address never changes. To use a nicer name, run it as `sudo KANBAN_HOSTNAME=kanban ./pi/install.sh` and open `http://kanban.local:8080`.

What the installer does (running it again is safe):
- Installs Node.js if needed. It uses Raspberry Pi OS's own package first, then falls back to NodeSource (64-bit) or the official build (32-bit armv7l).
- Copies the app to `/opt/kanban`. Your data lives in `/opt/kanban/data/` and is never overwritten by reinstalls.
- Creates `kanban.service`, which starts at boot and restarts itself if it ever stops. A one-minute watchdog also restarts it if it stops answering.
- Sets up the TV:
  - Chromium opens full screen on `http://localhost:8080/?tv=1`, with no pointer and no "restore pages" or error bubbles.
  - Screen blanking is turned off, and the Pi is set to boot to the desktop logged in.
  - Chromium is relaunched if it crashes or if the Pi runs very low on memory.
- Settings go in `/etc/kanban.env` (port, TV address, backups). There's also a commented placeholder for overnight screen-off hours.

Desktop note: current Raspberry Pi OS uses the **labwc (Wayland)** desktop on every model, the Pi 3 included. Older Pi 3 installs use **X11**. The installer sets up the TV for both. If the Pi 3 feels slow, `sudo KANBAN_X11=1 ./pi/install.sh` switches it to the lighter X11 desktop (takes effect after a reboot).

Useful commands:
```bash
systemctl status kanban            # is the server running?
journalctl -u kanban -f            # server log
cat ~/.cache/kanban-kiosk.log      # TV browser log
sudo /opt/kanban/pi/uninstall.sh   # remove (keeps a copy of your data in /var/backups; add --purge to delete it)
```

**Moving your v0.01 cards over:** in the old v0.01 file, click **⬇ Export**. Then open the new board and click **⬆ Import**.

## Known limitations (v0.02)

- **No login.** Anyone on your home network who knows the address can see and edit the board. Don't forward the port on your router. Secure access from outside the home (Tailscale + HTTPS) comes in **v0.03**.
- **Opening the board on a phone while the Pi is unreachable:** a page that's already open keeps working and queues your changes. But re-opening the page from scratch only works on the TV for now, because phones need HTTPS for offline storage. This is fixed in v0.03 together with the **installable Android app (PWA)**.
- **"Newest change wins" is per card.** If Person A changes the title and Person B changes the due date of the same card at the same moment, only the newer of the two edits is kept. Timestamps follow the Pi's clock, so a Pi with a badly wrong clock could pick the wrong winner.
- An offline edit made more than 60 days after a card was deleted could bring that card back (old delete records are cleaned up after 60 days).
- Reminders (🔔) still only fire while a page is open in a browser.
- The **shared Google Calendar** is planned for **v0.04**.
- Not yet tested on real Raspberry Pi hardware. The installer is syntax-checked and lint-checked, and everything else was tested against a simulated Pi (see below).

## Files

```
v0.02/
  server.js              tiny Node server (no npm packages): page + JSON API + live events
  public/index.html      the board (v0.01 + live sync, status dot, "Who are you?", TV mode)
  public/sw.js           small offline cache for the page (used where the browser allows it)
  pi/install.sh          one-command Pi setup        pi/uninstall.sh   removal
  pi/kiosk.sh            starts and minds Chromium   pi/watchdog.sh    restarts a stuck server
  test/sync.test.js      two-device tests against a local server (node test/sync.test.js)
  test/memory.test.js    Pi 3 memory check (test/run-memory-capped.sh runs it under a 450 MB cap)
  screenshots/           phone, desktop and 1080p TV screenshots
```

API (for the curious): `GET /api/board`, `PUT /api/card/:id`, `DELETE /api/card/:id`, `PUT /api/board` (replace, used by Import), `PUT /api/meta` (tag colors), `GET /api/events` (live updates), `GET /healthz`.
