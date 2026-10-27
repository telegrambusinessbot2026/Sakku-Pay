/* Run all 6 SakkuPay test suites */
'use strict';
const cp = require('child_process');
const suites = [
  'test-milestone1.js',
  'test-milestone2.js',
  'test-milestone3.js',
  'test-milestone4.js',
  'test-milestone5.js',
  'test-milestone6.js'
];

let allPassed = true;
const summary = [];

for (const suite of suites) {
  console.log(`\n>>> Executing ${suite}...`);
  const start = Date.now();
  const res = cp.spawnSync(process.execPath, [suite], { stdio: 'inherit', env: process.env });
  const duration = ((Date.now() - start) / 1000).toFixed(2);
  const ok = res.status === 0;
  if (!ok) allPassed = false;
  summary.push({ suite, ok, exitCode: res.status, duration: `${duration}s` });
}

console.log('\n' + '='.repeat(60));
console.log('ALL MILESTONES EXECUTION SUMMARY');
console.log('='.repeat(60));
for (const s of summary) {
  console.log(`${s.ok ? '✅' : '❌'} ${s.suite.padEnd(22)} Exit: ${s.exitCode} (${s.duration})`);
}
console.log('='.repeat(60));
process.exit(allPassed ? 0 : 1);
