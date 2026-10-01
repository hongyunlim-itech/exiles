// Aggregate QA run JSONs: node dev/qa-balance/analyze.mjs <prefix> [--detail]
import { readdirSync, readFileSync } from 'node:fs';

const prefix = process.argv[2] ?? 'm_';
const detail = process.argv.includes('--detail');
const files = readdirSync('dev/qa-balance/out').filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort();
const rows = [];
for (const f of files) {
  const r = JSON.parse(readFileSync('dev/qa-balance/out/' + f, 'utf8'));
  const ms = r.months;
  const popY = [];
  for (const m of ms) if (m.m === 0) popY.push(m.pop);
  const act = {};
  let cold = { adultSecCold: 0, adultSecWarmthLow: 0, adultSecFreezing: 0, houseSecNoWood: 0, houseSecCold: 0, homelessSec: 0, noToolWorkSec: 0, workSec: 0, coatlessColdOutdoorSec: 0, coldOutdoorSec: 0 };
  for (const m of ms) {
    for (const k in m.act) act[k] = (act[k] ?? 0) + m.act[k];
    for (const k in cold) cold[k] += m.cold?.[k] ?? 0;
  }
  const tot = Object.values(act).reduce((a, b) => a + b, 0) || 1;
  const pct = (k) => ((act[k] ?? 0) / tot * 100).toFixed(0);
  const minFood = Math.min(...ms.map((m) => m.food + m.houseFood));
  const maxFood = Math.max(...ms.map((m) => m.food + m.houseFood));
  const endFood = ms.at(-1).food + ms.at(-1).houseFood;
  const minFw = Math.min(...ms.filter((m) => m.m >= 8 || m.m <= 1).map((m) => m.firewood + m.houseFw));
  const minTools = Math.min(...ms.map((m) => m.tools));
  const endTools = ms.at(-1).tools;
  const foodMsgs = r.messages.filter((x) => x.text.startsWith('Food is running low'));
  const d = r.deaths;
  const dd = Object.entries(d).map(([k, v]) => `${k}:${v}`).join(' ');
  rows.push({
    name: r.cfg.name, over: r.gameOver ? `OVER@${r.endYear}` : '', pop: popY.join(','), end: ms.at(-1).pop, births: r.births, deaths: dd,
    idle: pct('idle') + '+' + pct('idleWalk'), travel: pct('travel'), work: pct('work'), eat: pct('eat'), warm: pct('warm'), sick: pct('sick'),
    food: `${Math.round(minFood)}/${Math.round(maxFood)}/${Math.round(endFood)}`, fwMinWinter: minFw, tools: `${minTools}/${endTools}`,
    noWoodHouse: cold.houseSecCold ? (cold.houseSecNoWood / cold.houseSecCold * 100).toFixed(0) + '%' : '-',
    lowWarm: cold.adultSecCold ? (cold.adultSecWarmthLow / cold.adultSecCold * 100).toFixed(0) + '%' : '-',
    freezing: cold.adultSecCold ? (cold.adultSecFreezing / cold.adultSecCold * 100).toFixed(1) + '%' : '-',
    noToolWork: cold.workSec ? (cold.noToolWorkSec / cold.workSec * 100).toFixed(0) + '%' : '-',
    coatless: cold.coldOutdoorSec ? (cold.coatlessColdOutdoorSec / cold.coldOutdoorSec * 100).toFixed(0) + '%' : '-',
    homelessSec: cold.homelessSec,
    foodMsgs: foodMsgs.length, stuck: Object.values(r.stuck).reduce((a, b) => a + b, 0), errs: Object.keys(r.moduleErrors ?? {}).length,
    health: `${Math.min(...ms.map((m) => m.health))}/${ms.at(-1).health}`, happy: `${Math.min(...ms.map((m) => m.happy))}/${ms.at(-1).happy}`,
  });
  if (detail) {
    console.log('==', r.cfg.name, JSON.stringify(r.deaths), 'stuck', JSON.stringify(r.stuck));
    for (const m of ms) if (m.m % 3 === 0) console.log(`  y${m.y}m${m.m} pop${m.pop} ad${m.adults} k${m.kids} st${m.students} 10-15:${m.a10to15} s16:${m.single16} cpl${m.couples} hl${m.homeless} h${m.houses}/e${m.emptyHouses}/f${m.housesFull} food${m.food}+${m.houseFood}+b${m.bufFood} fw${m.firewood}+${m.houseFw} logs${m.logs} st${m.stone} ir${m.iron} tl${m.tools} ct${m.coats} hb${m.herbs} H${m.health} J${m.happy} sick${m.sick} noTool${m.noTool} noCoat${m.noCoat} T${m.tempMin}/${m.tempAvg} wmin${m.warmthMin} lab${m.laborers} b${m.births} d${JSON.stringify(m.deaths)}`);
  }
}
const cols = Object.keys(rows[0] ?? {});
console.log(cols.join('\t'));
for (const r of rows) console.log(cols.map((c) => r[c]).join('\t'));
