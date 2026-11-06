import argparse
import errno
import os
import sys
import webbrowser

from . import __version__
from .server import (
    ACCESS_MODES, PIN_RE, Server, State, clean_name, computer_name, default_config_path,
    load_instance_config, valid_link,
)

DEFAULT_PORT = 8765
DEFAULT_SAVE_DIR = os.path.expanduser("~/Downloads/PierHop")
PORT_TRIES = 10
ACCESS_HELP = {
    "pin": "devices must enter the PIN",
    "approve": "you approve each new device on the control page",
    "open": "anyone with the link can connect",
}


def print_qr(url):
    try:
        import qrcode
    except ImportError:
        return
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    qr.print_ascii(invert=True)


def start_server(port, state):
    for p in range(port, port + PORT_TRIES):
        try:
            return Server(p, state), p
        except OSError as e:
            if e.errno != errno.EADDRINUSE:
                raise
    sys.exit(f"Ports {port}–{port + PORT_TRIES - 1} are all in use. Try --port 9000")


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="pierhop",
        description="Move files and text between your computer and your other devices over Wi-Fi. "
        "Nothing to install on the devices; they just use the browser.",
    )
    ap.add_argument("paths", nargs="*", help="files or folders to share right away (folders are zipped)")
    ap.add_argument("-p", "--port", type=int, default=DEFAULT_PORT,
                    help=f"port to listen on (default {DEFAULT_PORT}; the next free one is used if taken)")
    ap.add_argument("--name", help="name for this PierHop, shown on devices (default: the computer's name)")
    ap.add_argument("--link", help="custom link path, e.g. --link music gives http://IP:PORT/music/")
    ap.add_argument("--access", choices=ACCESS_MODES,
                    help="who can connect: " + "; ".join(f"{k} = {v}" for k, v in ACCESS_HELP.items()))
    ap.add_argument("--pin", help="use this PIN (4–12 digits) instead of a random one; implies --access pin")
    ap.add_argument("--save-dir", default=DEFAULT_SAVE_DIR,
                    help=f"where files from devices go (default {DEFAULT_SAVE_DIR})")
    ap.add_argument("--no-browser", action="store_true", help="don't open the control page")
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)

    if args.link is not None and not valid_link(args.link):
        sys.exit("--link must be 1–40 letters, numbers, - or _ (and not 'api' or 'static').")
    if args.pin is not None and not PIN_RE.match(args.pin):
        sys.exit("--pin must be 4–12 digits.")
    if args.pin and args.access not in (None, "pin"):
        sys.exit("--pin only makes sense with --access pin.")
    if args.name is not None and not clean_name(args.name):
        sys.exit("--name can't be empty.")

    state = State(
        os.path.abspath(os.path.expanduser(args.save_dir)),
        pin=args.pin,
        config_path=default_config_path(),
    )
    try:
        for p in args.paths:
            try:
                state.share_path(p)
            except FileNotFoundError:
                sys.exit(f"Not found: {p}")

        server, port = start_server(args.port, state)
        state.port = port
        if port != args.port:
            state.default_name = f"{computer_name()} ({port})"

        # Saved settings belong to this port; command-line flags win for this run.
        cfg = load_instance_config(state.config_path, port)
        saved_link = cfg.get("link")
        state.custom_link = args.link or (saved_link if valid_link(saved_link) else None)
        if valid_link(cfg.get("random_link")):
            state.random_link = cfg["random_link"]
        state.custom_name = clean_name(args.name) or clean_name(cfg.get("name"))
        saved_access = cfg.get("access") if cfg.get("access") in ACCESS_MODES else "pin"
        state.access = args.access or ("pin" if args.pin else saved_access)
        state.remember = cfg.get("remember") is True
        if state.remember:
            state.restore_devices(cfg.get("devices"))
        state.persist()  # so the random link is saved from the first run

        host_url = f"http://127.0.0.1:{port}/"
        device_url = state.device_url()
        print(f"\n  PierHop is running as \"{state.name}\".\n")
        print(f"  Control page (this computer):  {host_url}")
        print(f"  Devices (same Wi-Fi):          {device_url}")
        if state.access == "pin":
            print(f"  PIN:                           {state.pin}")
        else:
            print(f"  Access:                        {ACCESS_HELP[state.access]}")
        print(f"  Files from devices go to:      {state.save_dir}\n")
        print_qr(device_url)
        print("  Ctrl+C to stop.\n")

        if not args.no_browser:
            webbrowser.open(host_url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\n  Stopped.")
        finally:
            server.server_close()
            state.persist()  # keeps the devices' "last seen" times
    finally:
        state.cleanup()
