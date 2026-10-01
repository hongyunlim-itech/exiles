// Bundle the sim-core balance runner for plain node: npx rolldown -c dev/sim-core/rolldown.config.mjs
export default {
  input: { balance: 'dev/sim-core/balance.ts' },
  platform: 'node',
  output: { dir: 'dev/sim-core/build', entryFileNames: '[name].mjs', format: 'esm' },
};
