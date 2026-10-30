#!/usr/bin/env python3
"""Serve the repository root over HTTPS on localhost:8085 (stdlib only).

Loopback TLS so the mobile simulator's live mode passes the partner API's
browser-origin allowlist (CORS). Generate a throwaway self-signed cert and
run from the repository root:

    openssl req -x509 -newkey rsa:2048 -nodes -days 14 \
      -keyout tmp/dev-key.pem -out tmp/dev-cert.pem -subj "/CN=localhost"
    python3 examples/mobile-sim/serve-https.py tmp/dev-cert.pem tmp/dev-key.pem

Then open https://localhost:8085/examples/mobile-sim/sim.html and accept the
self-signed certificate warning once. Development harness only: never serve
real partner traffic from this script.
"""
import functools
import http.server
import os
import ssl
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("usage: serve-https.py <cert.pem> <key.pem>")
    cert, key = sys.argv[1], sys.argv[2]
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8085), handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"serving {ROOT} at https://127.0.0.1:8085 (accept the cert warning once)")
    server.serve_forever()


if __name__ == "__main__":
    main()