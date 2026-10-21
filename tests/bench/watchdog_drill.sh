#!/usr/bin/env bash
# Учения сторожа (решения 21.10.2026). Сценарий ведёт tests/api/drill_watchdog.py и печатает
# «DRILL STOP <сервис> <цель>»; SIGSTOP шлёт этот скрипт с хоста — из контейнера тестов до процессов
# воркеров не достать. Пороги на время учений — tests/bench/drill.compose.yml.
#   tests/bench/watchdog_drill.sh [аргументы pytest, например -k тёплый]
set -u
export MSYS_NO_PATHCONV=1 LC_ALL=C
TESTS=${TESTS:-yolo-tests}
LOG=$(mktemp)

# pid цели внутри контейнера: родитель — по файлу сторожа, ребёнок — по строке «<имя>: процесс N» журнала.
pid_of() {
  case "$2" in
    parent) docker exec "$1" cat /tmp/alive/pid ;;
    pid:*) echo "${2#pid:}" ;;
    sam2) docker exec "$1" sh -c 'for p in /proc/[0-9]*; do grep -qa spawn_main $p/cmdline 2>/dev/null \
            && ! grep -qa resource_tracker $p/cmdline && echo ${p#/proc/}; done' ;;
    *) docker logs "$1" 2>&1 | grep -ao "$2: процесс [0-9]*" | tail -1 | awk '{print $3}' ;;
  esac
}

act() {
  case "$1" in
    *"DRILL STOP "*)  # pytest дописывает метку к своей «.» или «F» на той же строке
      set -- ${1#*DRILL STOP }
      for p in $(pid_of "yolo-$1" "$2"); do
        docker exec "yolo-$1" sh -c "kill -STOP $p" && echo ">>> SIGSTOP yolo-$1 $2 ($p)"  # kill — встроенная команда оболочки, бинарника в образе нет
      done ;;
  esac
}

docker exec "$TESTS" python3 -u -m pytest /work/tests/api/drill_watchdog.py -q -s -p no:cacheprovider "$@" \
  > "$LOG" 2>&1 &
TEST=$!
tail -n +1 -f --pid=$TEST "$LOG" | while IFS= read -r line; do
  echo "$line"
  act "$line"
done
wait $TEST
