// visual-diff.js — visual regression: current surfaces vs committed goldens.
//
// Shoots all 8 workspaces into a temp dir, then pixel-diffs each against
// tools/visual/goldens/. A small threshold absorbs anti-aliasing and the
// date text that legitimately drifts day to day; anything larger fails and
// a *-diff.png is written next to the candidate for review.
//
// Usage:
//   node tools/visual/visual-diff.js            # compare against goldens
//   node tools/visual/visual-diff.js --update   # re-shoot and bless as goldens
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PNG } = require('pngjs');
const pixelmatchModule = require('pixelmatch');
const pixelmatch = pixelmatchModule.default || pixelmatchModule;

const GOLDEN_DIR = path.join(__dirname, 'goldens');
const CANDIDATE_DIR = path.join(__dirname, 'candidate');
// Date chips, "Nd since touch" ages and the live month grid legitimately move;
// anything beyond this fraction of pixels is a real regression.
const MAX_DIFF_RATIO = 0.02;

function shoot(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(__dirname, 'shoot.js'), outDir], { stdio: 'inherit' });
}

function compareOne(name) {
  const goldenPath = path.join(GOLDEN_DIR, name);
  const candidatePath = path.join(CANDIDATE_DIR, name);
  if (!fs.existsSync(candidatePath)) return { name, status: 'MISSING-CANDIDATE' };
  const golden = PNG.sync.read(fs.readFileSync(goldenPath));
  const candidate = PNG.sync.read(fs.readFileSync(candidatePath));
  if (golden.width !== candidate.width || golden.height !== candidate.height) {
    return { name, status: 'SIZE-MISMATCH' };
  }
  const diff = new PNG({ width: golden.width, height: golden.height });
  const differing = pixelmatch(golden.data, candidate.data, diff.data, golden.width, golden.height, { threshold: 0.12 });
  const ratio = differing / (golden.width * golden.height);
  if (ratio > MAX_DIFF_RATIO) {
    const diffPath = candidatePath.replace(/\.png$/, '-diff.png');
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    return { name, status: 'FAIL', ratio, diffPath };
  }
  return { name, status: 'ok', ratio };
}

function main() {
  const update = process.argv.includes('--update');
  if (update) {
    shoot(GOLDEN_DIR);
    console.log(`\nGoldens updated in ${path.relative(process.cwd(), GOLDEN_DIR)}`);
    return;
  }
  if (!fs.existsSync(GOLDEN_DIR)) {
    console.error('No goldens committed yet — run with --update first.');
    process.exit(1);
  }
  shoot(CANDIDATE_DIR);
  const goldens = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.png'));
  let failures = 0;
  for (const name of goldens) {
    const result = compareOne(name);
    const pct = result.ratio != null ? ` (${(result.ratio * 100).toFixed(2)}% differs)` : '';
    console.log(`${result.status === 'ok' ? ' ok ' : 'FAIL'} ${name}${pct}${result.diffPath ? ` → ${path.relative(process.cwd(), result.diffPath)}` : ''}`);
    if (result.status !== 'ok') failures++;
  }
  console.log(failures ? `\nVisual regression: ${failures} surface(s) drifted.` : '\nVisual regression PASSED.');
  process.exit(failures ? 1 : 0);
}

main();
