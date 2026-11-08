#!/bin/sh
# PID 1 контейнера Synth: reaping + проброс сигналов + проброс кода выхода.
#
# Зачем два уровня (этот скрипт и `dist/init.js` внутри):
#   * reaping осиротевших детей может сделать только PID 1, и сделать это
#     должен тот, кто вызывает `waitpid(-1)`. Node/libuv так НЕ умеет: libuv
#     ждёт только pids своих handle'ов (`waitpid(process->pid)`), а осиротевшие
#     потомки убитого родителя переподвешиваются к PID 1 и остаются зомби.
#     POSIX-шелл в обработчике SIGCHLD жнёт всех детей, включая усыновлённых,
#     поэтому PID 1 — этот скрипт (аудит 0.13.4 §5.2: 38–42 зомби).
#   * проброс сигнала всей process group и код выхода (в т.ч. 75 — рестарт,
#     ADR-092) делает `dist/init.js` — маленькая Node-обёртка
#     (`packages/backend/src/init.ts`, `packages/executor/src/init.ts`).
#
# Нужен только `sh` (есть в alpine/busybox и debian) — пакеты в runtime-стадию
# образа не добавляются, `tini`/`docker-init` не требуются. В docker-compose
# дополнительно включён `init: true` (docker-init как PID 1) — страховка для
# случая, когда команда образа переопределена (`docker compose run`).
#
# Использование (CMD образа):
#   ["/usr/local/bin/synth-init", "node", "dist/init.js"]
#
# Проверка в контейнере: `ps -o pid,ppid,stat,comm` — строк со `stat` = `Z`
# быть не должно (см. docs/MAINTENANCE.md, «PID 1 и зомби»).

set -u

if [ "$#" -eq 0 ]; then
  echo "[init] не задана команда запуска (usage: synth-init <command> [args...])" >&2
  exit 1
fi

child=
pending=

# Переслать сигнал дочернему процессу. Если сигнал пришёл до старта ребёнка —
# запоминаем и перешлём сразу после `$!`.
forward() {
  if [ -z "$child" ]; then
    pending="$1"
    return 0
  fi
  kill "-$1" "$child" 2>/dev/null || true
}

trap 'forward TERM' TERM
trap 'forward INT' INT
trap 'forward HUP' HUP

"$@" &
child=$!

if [ -n "$pending" ]; then
  signal=$pending
  pending=
  forward "$signal"
fi

# `wait` прерывается сигналом (trap выше) — ждём до фактического завершения
# ребёнка и берём ИМЕННО его код выхода (75 — рестарт, 128+N — гибель от
# сигнала): статус завершившегося ребёнка шелл сохраняет до `wait`.
code=0
while :; do
  wait "$child"
  code=$?
  kill -0 "$child" 2>/dev/null || break
done

exit "$code"
