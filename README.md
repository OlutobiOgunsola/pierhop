<p><img src="web/public/logo.svg" alt="" width="72"></p>

# PierHop

**If they have a browser, they can get your files.**

Create a pier, send the link, and swap files with anyone on any phone or
computer, anywhere in the world. No app, no account, nothing uploaded.

## How piers work

1. **Create a pier.** You get a link like `pierhop.com/kqv-dhmw-tpx`.
2. **Let people in.** Anyone who opens the link types their name and knocks.
   You choose **Let in** or **Deny**.
3. **Swap files.** Everyone on the pier can share files and download what
   others share, in both directions.

Files go straight from one browser to another over WebRTC. The server only
keeps the guest list and helps browsers find each other; it never sees a file
and stores nothing. The one catch: whoever is sharing has to stay online until
the others have the file. When the host ends the pier, it's gone.

**Private, even from us.** Each pier has a random 256-bit key in the link's
fragment (after the `#`), which browsers never send to a server. Browsers sign
their DTLS fingerprints with an HMAC derived from it, so a server that tried to
intercept a connection would be caught and refused. On top of DTLS, every chunk
is encrypted with AES-256-GCM under a fresh per-transfer key (HKDF from the
pier key and a random salt). File names and lists only travel inside those
connections.

**Picks up where it stopped.** Downloads are written to the browser's origin
private file system with a confirmed position every 2 MB. If a connection
drops, or either person refreshes, people rejoin without knocking and the
transfer carries on from the last confirmed byte. A sender who refreshes just
shares the same file again.

### Run it locally

The website and the pier server live in `web/`: a static site plus a
Cloudflare Worker with one Durable Object per pier.

```
cd web
npm install
npx wrangler dev          # http://localhost:8787
```

`npx wrangler deploy` publishes it to your Cloudflare account. Wrangler is
pinned to 4.86, the last version that runs on Node.js 20.

`web/test/pier.e2e.mjs` is an end-to-end test that plays four people in
separate browser sessions: knocking, letting in and denying, files in every
direction checked byte for byte, resuming after a dropped connection and after
either side refreshes, a check that no file name or key ever reaches the server,
a simulated malicious server tampering with a connection, removal and ending. Start `wrangler dev` and a
Chrome with `--remote-debugging-port=9336`, then run
`node --experimental-websocket web/test/pier.e2e.mjs`.

## The PierHop app for your own network

The `pierhop` Python app serves a page to every device on your Wi-Fi from a
Mac or Linux machine. Use it to share whole folders, preview photos and video,
and keep it running all day. The other devices need nothing installed.

```
pipx install pierhop    # or: pip install pierhop
pierhop
```

To run it from a clone without installing anything, use `python3 -m pierhop`.
Building from source needs pip 21.3 or newer. The pip that ships with macOS
is older, so run `pip install --upgrade pip` first.

A control page opens in your computer's browser. Scan its QR code with your
phone and you're connected.

### What it does

- **Computer → devices:** add files or folders with the native file picker,
  or drag them onto the control page. Adding a file doesn't send it; it shows
  up in a list on each device, which downloads only what it wants.
- **Browse folders:** a shared folder opens on the device like a file manager.
  Pick single files out of it, or download it all as a zip. The zip is built
  while it downloads, so there's no wait and no temporary copy, and it works
  for folders over 4 GB.
- **Preview without downloading:** photos, videos, music and text files open
  right in the device's browser, with next/previous for photos.
- **Download several at once:** tap *Select*, pick files and folders, and get
  them as one zip.
- **Per-device sharing:** a file is visible to all devices by default. Use its
  visibility setting to limit it to certain devices.
- **Devices → computer:** tap *Choose files* on the device. Files land in
  `~/Downloads/PierHop` and you get a notification.
- **Text and links:** send a link or snippet to all devices or to one. Text a
  device sends is seen only by the computer and that device.
- **Many devices at once:** every device gets a name, such as "Android phone"
  or "iPad", which you or the device can change. The control page shows who's
  online and lets you disconnect any of them.
- **Same link every time:** the random link stays the same each time you run
  PierHop on the same port, so a bookmark on your phone keeps working.
- **Live progress:** shows speed and time left for every transfer.
- **Custom link:** use `http://<ip>:8765/music/` instead of a random code.
- **Several at once:** start PierHop again and the new instance takes the next free
  port. Each instance has its own name, link and settings.

Everything stays on your local network. Nothing is uploaded anywhere.

### Who can connect

Pick one on the control page (Settings → *Who can connect*) or with `--access`:

| Mode | How a new device gets in |
|---|---|
| `pin` (default) | It enters the 6-digit PIN shown on the control page. Five wrong tries locks that device out for a minute. |
| `approve` | You get an **Allow / Deny** prompt on the control page (and a notification). |
| `open` | Anyone with the link gets in. Only for networks you trust. |

Devices that are already connected stay connected when you change the mode or
the PIN. To remove one, click **Disconnect**. It then has to get in again.

When PierHop restarts, every device needs the PIN or your approval again, so no
one gets back in without you knowing. If you'd rather your own devices
reconnect by themselves, turn on Settings → *Remember devices when PierHop
restarts*. Devices not seen for 90 days are forgotten even then, and turning
the setting off deletes the saved ones.

### Usage

```
pierhop [FILES/FOLDERS ...] [options]

  -p, --port PORT              port to listen on (default 8765; the next free one is used if taken)
  --name NAME                  name shown on devices (default: the computer's name)
  --link NAME                  custom link path, e.g. --link music
  --access {pin,approve,open}  who can connect (see above)
  --pin 1234                   use a fixed PIN instead of a random one
  --save-dir DIR               where files from devices go (default ~/Downloads/PierHop)
  --no-browser                 don't open the control page automatically
```

Examples:

```
pierhop                                # start it; add files from the control page
pierhop ~/Music/mix.wav ~/Photos/trip  # share these right away
pierhop --name Studio --link studio --access approve
```

Settings you change on the control page are remembered for that port. Flags apply to the current run only.

Install with `pip install "pierhop[qr]"` to also print the QR code in the
terminal.

### Requirements

- Python 3.9+ (the version that ships with macOS Command Line Tools works)
- The computer and devices on the same Wi-Fi network
- No third-party Python packages

The first time you run it, macOS may ask whether Python can accept incoming
network connections. Click **Allow**, or devices won't be able to connect.

It also runs on Linux. The native file picker and notifications are
macOS-only, so on Linux you drag files onto the page instead.

### Security notes

- Traffic is plain HTTP on your LAN. Anyone who can sniff your Wi-Fi could see
  what's transferred, so use it on networks you trust.
- Only the computer running PierHop can open the control page. It checks that
  the request comes from localhost, rejects other Host headers (which blocks
  DNS rebinding), and requires a per-run key.
- Each device has its own identity cookie (HttpOnly, SameSite=Strict), so
  disconnecting one device doesn't affect the others. When devices are
  remembered, the settings file only stores a hash of each device's cookie,
  and only your user can read it.
- In a shared folder, hidden files (such as `.DS_Store` and `.git`) aren't
  listed, and neither are symlinks that point outside the folder.
- Previews are limited to images, video, audio and plain text. HTML and SVG
  files always download instead of opening, so a shared web page can't run
  scripts on the device page.
- The device link has a random path by default. With a custom path, keep the
  PIN or approval on.

### Troubleshooting

- **A device can't open the link:** check that both are on the same network,
  without guest-network or "AP isolation" mode. Also check System Settings →
  Network → Firewall, and allow Python if it's blocked.
- **Wrong IP shown:** if the computer is on several networks (VPN, Ethernet
  and Wi-Fi), PierHop picks the one with the default route. Disconnect the VPN
  or use the right interface's IP.

## Development

```
python3 -m unittest discover -s tests -v   # end-to-end tests, no dependencies
python3 -m pierhop --no-browser           # run from the checkout
```

CI runs the tests on macOS and Linux with Python 3.9 and 3.13.

## Credits

The QR code generator is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
by Kazuhiko Arase (MIT). The landing page uses the [Geist](https://github.com/vercel/geist-font)
typefaces (SIL Open Font License, included in `web/public/fonts/` and `pierhop/static/`).

## License

MIT
