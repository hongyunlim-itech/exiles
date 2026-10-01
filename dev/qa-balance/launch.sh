#!/bin/bash
# usage: NS=8 LOG=name [env...] bash dev/qa-balance/launch.sh
NS=${NS:-8}
LOG=${LOG:-run}
mkdir -p dev/qa-balance/out/logs
for ((i=0;i<NS;i++)); do
  SHARD=$i NSHARD=$NS node dev/qa-balance/build/run.mjs > dev/qa-balance/out/logs/${LOG}_$i.txt 2>&1 &
done
wait
echo "done $LOG"
