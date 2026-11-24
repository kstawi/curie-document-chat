// Flags wording that reads as generic AI output in docs, comments and UI text (see CLAUDE.md, "Writing").
// Usage: npm run scan:phrases. Exits with 1 when something is found.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skip = new Set(['node_modules', 'dist', 'coverage', '.git', 'fixtures']);
// CLAUDE.md quotes the phrases on purpose, so it only gets the style checks; this script quotes everything.
const quotesPhrases = new Set(['CLAUDE.md']);
const skipFiles = new Set(['scripts/phrase-scan.mjs']);
const scanned = /\.(md|tsx?|m?js|ya?ml)$|^Dockerfile$|^\.env\.example$/;

const phrases = [
  'production-grade',
  'production-ready',
  'end to end',
  'end-to-end',
  'pioneered',
  'gated by',
  'robust',
  'seamless',
  'seamlessly',
  'leverage',
  'leveraging',
  'comprehensive',
  'delve',
  'empower',
  'unlock',
  'cutting-edge',
  'state-of-the-art',
  'streamline',
  'elevate',
  'key features',
  "it's not just",
  'game-changer',
  "in today's",
  'rest assured',
  "let's dive",
];
// Straight or curly apostrophes, hyphens taken literally.
const pattern = (p) => p.replace(/-/g, '\\-').replace(/'/g, "['’]");
const phraseChecks = phrases.map((p) => [new RegExp(`\\b${pattern(p)}\\b`, 'i'), `"${p}"`]);
const styleChecks = [
  [/~\s?\d/, 'tilde before a number (write "about N")'],
  [/—[^—\n]*—/, 'two or more em dashes in one line'],
  [/^#+ .*\p{Extended_Pictographic}/u, 'emoji in a heading'],
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (scanned.test(name)) yield path;
  }
}

let found = 0;
for (const path of files(root)) {
  const rel = relative(root, path).replaceAll('\\', '/');
  if (skipFiles.has(rel)) continue;
  const checks = quotesPhrases.has(rel) ? styleChecks : [...phraseChecks, ...styleChecks];
  const isProse = rel.endsWith('.md') || rel.endsWith('.env.example');
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      // Outside Markdown only comments and string literals are prose; a rough filter is enough here.
      if (!isProse && !/\/\/|\/\*|\*|#|['"`]/.test(line)) return;
      for (const [re, label] of checks) {
        if (re.test(line)) {
          console.log(`${rel}:${i + 1}: ${label}`);
          found++;
        }
      }
    });
}
console.log(found ? `${found} finding(s)` : 'No findings');
process.exit(found ? 1 : 0);
