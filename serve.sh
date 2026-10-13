#!/bin/sh
# Serve the static ESP-WebSDR viewer on localhost. localhost is a secure
# context, so WebSerial / WebUSB work without HTTPS. Usage: ./serve.sh [port]
cd "$(dirname "$0")" && exec python3 -m http.server "${1:-8000}"
