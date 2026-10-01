#!/bin/sh
# usage: sh dev/qa-player/run.sh file.js   OR   echo 'js' | sh dev/qa-player/run.sh -
PORT=${QPORT:-6221}
if [ "$1" = "-" ]; then curl -s --max-time 900 -X POST --data-binary @- http://localhost:$PORT/; else curl -s --max-time 900 -X POST --data-binary @"$1" http://localhost:$PORT/; fi
echo
