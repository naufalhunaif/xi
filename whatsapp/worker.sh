#!/usr/bin/env bash
# Kendali worker WhatsApp (node ace whatsapp:listen).
#
#   ./worker.sh           restart (hentikan yang jalan, lalu jalankan lagi)
#   ./worker.sh start     jalankan kalau belum jalan
#   ./worker.sh stop      hentikan saja
#   ./worker.sh status    lihat status
#   ./worker.sh log       ikuti log berjalan
#
# Worker dijalankan di latar belakang, lognya masuk ke tmp/whatsapp-listen.log
# sehingga Terminal bisa ditutup tanpa mematikan worker.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

APP_DIR="$(pwd)"
LOG_DIR="$APP_DIR/tmp"
LOG_FILE="$LOG_DIR/whatsapp-listen.log"
PID_FILE="$LOG_DIR/whatsapp-listen.pid"
PATTERN='whatsapp:listen'
ACTION="${1:-restart}"

mkdir -p "$LOG_DIR"

running_pids() {
  # Semua proses worker, kecuali skrip ini sendiri.
  pgrep -f "$PATTERN" 2>/dev/null | while read -r pid; do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    ps -p "$pid" -o command= 2>/dev/null | grep -q "worker.sh" && continue
    echo "$pid"
  done
}

stop_worker() {
  pids="$(running_pids)"
  if [ -z "$pids" ]; then
    echo "Worker tidak sedang berjalan."
    rm -f "$PID_FILE" 2>/dev/null || :
    return 0
  fi
  echo "Menghentikan worker: $(echo "$pids" | tr '\n' ' ')"
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null; done
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    [ -z "$(running_pids)" ] && break
  done
  pids="$(running_pids)"
  if [ -n "$pids" ]; then
    echo "Masih hidup, dipaksa berhenti."
    for pid in $pids; do kill -KILL "$pid" 2>/dev/null; done
    sleep 1
  fi
  rm -f "$PID_FILE" 2>/dev/null || :
  echo "Worker berhenti."
}

start_worker() {
  if [ -n "$(running_pids)" ]; then
    echo "Worker sudah berjalan (PID $(running_pids | tr '\n' ' '))."
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "node tidak ditemukan di PATH. Buka Terminal biasa lalu jalankan lagi."
    return 1
  fi
  echo "Node $(node -v) — menjalankan worker..."
  nohup node ace whatsapp:listen >> "$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" > "$PID_FILE" 2>/dev/null || :
  sleep 3
  if kill -0 "$pid" 2>/dev/null; then
    echo "Worker jalan (PID $pid). Log: $LOG_FILE"
    echo "--- 15 baris log terakhir ---"
    tail -n 15 "$LOG_FILE" 2>/dev/null
  else
    echo "Worker gagal start. Log terakhir:"
    tail -n 30 "$LOG_FILE" 2>/dev/null
    rm -f "$PID_FILE" 2>/dev/null || :
    return 1
  fi
}

case "$ACTION" in
  stop)
    stop_worker
    ;;
  start)
    start_worker
    ;;
  status)
    pids="$(running_pids)"
    if [ -n "$pids" ]; then
      echo "Berjalan (PID $(echo "$pids" | tr '\n' ' '))"
      tail -n 10 "$LOG_FILE" 2>/dev/null
    else
      echo "Tidak berjalan."
    fi
    ;;
  log)
    tail -n 50 -f "$LOG_FILE"
    ;;
  restart|"")
    stop_worker
    start_worker
    ;;
  *)
    echo "Pilihan: restart | start | stop | status | log"
    exit 1
    ;;
esac
