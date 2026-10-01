// QA bundle: turns top-level UPPER_CASE numeric constants of the sim into runtime knobs (globalThis.__QA) so tuning
// experiments need no source edits. Run: npx rolldown -c dev/qa-balance/rolldown.config.mjs
const knobFiles = /src[\\/](core[\\/]constants|core[\\/]defs|sim[\\/]core[\\/](citizens|tuning|farming|steps|households|buildings)|sim[\\/]ext[\\/]tuning)\.ts$/;

const knobPlugin = {
  name: 'qa-knobs',
  transform(code, id) {
    if (!knobFiles.test(id)) return null;
    let out = code.replace(/^(export )?const ([A-Z][A-Z0-9_]*) = ([^;{}[\]]+);/gm, (m, ex, name, expr) =>
      `${ex ?? ''}const ${name} = (globalThis.__QA && globalThis.__QA.${name} !== undefined) ? globalThis.__QA.${name} : (${expr});`);
    // unheated home warmth target
    out = out.replace('clamp(45 + temp * 4, 10, 70)', '(globalThis.__QA && globalThis.__QA.COLD_HOME ? globalThis.__QA.COLD_HOME(temp) : clamp(45 + temp * 4, 10, 70))');
    return { code: out };
  },
};

export default {
  input: { run: "dev/qa-balance/run.ts", probes: "dev/qa-balance/probes.ts" },
  platform: 'node',
  plugins: [knobPlugin],
  output: {
    dir: "dev/qa-balance/build", entryFileNames: "[name].mjs",
    format: 'esm',
    banner: "globalThis.__QA = (() => { try { const k = JSON.parse(process.env.QA_KNOBS || '{}'); for (const n in k) if (typeof k[n] === 'string' && k[n].startsWith('fn:')) k[n] = new Function('temp', k[n].slice(3)); return k; } catch (e) { console.error('bad QA_KNOBS', e); return {}; } })();",
  },
};
