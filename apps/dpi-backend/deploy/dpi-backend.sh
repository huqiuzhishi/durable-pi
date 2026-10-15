#!/bin/sh
# Durable Pi device server (dpi-backend) for hosts without launchd or systemd. Started under setsid, so
# stopping it signals the whole process group: this loop, the backend and the shells its agents run.
export PATH="__PATH__" HOME="__HOME__" DPI_HOME="__DPI_HOME__" NODE_NO_WARNINGS=1
cd "__APP__" || exit 1
while :; do
  "__NODE__" "__APP__/node_modules/tsx/dist/cli.mjs" src/main.ts >>"__LOG__" 2>&1
  sleep 2
done
