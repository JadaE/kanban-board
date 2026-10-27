# Kanban Board

A shared, offline-tolerant Kanban board for two people. A small Node server (`v0.02/server.js`, no dependencies) holds the board and pushes live updates to every open screen; the front end is a single static page (`v0.02/public/index.html`) with a service worker, plus a TV mode (`?tv=1`) for a wall display. `v0.02/pi/` has install, kiosk and watchdog scripts for a Raspberry Pi.

## Run
```bash
cd v0.02
node server.js     # open http://localhost:8080  (TV view: /?tv=1)
```
Requires Node 18+. See `v0.02/README.md` for details.

## Tests
```bash
npm install                 # playwright-core (repo root)
cd v0.02 && node test/sync.test.js   # needs Google Chrome at /usr/bin/google-chrome (CHROME=... to override)
```


## People
The two-person picker uses generic labels, `Person A` (`persona`) and `Person B` (`personb`). To use real names, edit the `OWNERS` / `PEOPLE` tables and the two picker buttons in `v0.02/public/index.html`. An existing board exported with other owner keys needs its `owner` / `lastEditedBy` values renamed to `persona` / `personb` before import.

## Not included
- Board data (`board.json` and its rolling backups, kept by the server outside the repo) and any exported board `.json` files.
- Test screenshots (`v0.02/screenshots/`).
- Hosting secrets: the here.now publishing config (slug, secret path, collection ids) used to host the web view; this repo only contains the app and Pi scripts.
