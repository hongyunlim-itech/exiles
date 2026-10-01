#!/bin/sh
# usage: sh dev/qa-ux/run.sh file.js   OR   echo 'js' | sh dev/qa-ux/run.sh -
PORT=${QPORT:-5321}
if [ "$1" = "-" ]; then curl -s --max-time 600 -X POST --data-binary @- http://localhost:$PORT/; else curl -s --max-time 600 -X POST --data-binary @"$1" http://localhost:$PORT/; fi
echo
