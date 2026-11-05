import { readFileSync, lstatSync } from 'node:fs';
import { basename } from 'node:path';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A local, explicit allowlist; this command does not publish or create a repository.
const root = new URL('./', import.meta.url);
const files = readFileSync(new URL('./public-files.txt', root), 'utf8').split(/\r?\n/)
  .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
if (new Set(files).size !== files.length) throw new Error('Duplicate release file');
let key;
try { key = parseEnv(readFileSync(new URL('./.env.local', root), 'utf8')).CLOCKED_API_KEY; } catch {}
for (const file of files) {
  if (basename(file) !== file || (file.startsWith('.env') && file !== '.env.example')
    || file.startsWith('eval-results-') || /\.log$/.test(file)) throw new Error('Private file rejected');
  const url = new URL(file, root), stat = lstatSync(url);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Release requires regular files');
  const bytes = readFileSync(url);
  if (key && bytes.includes(Buffer.from(key))) throw new Error(`Credential found in ${file}; packaging stopped`);
}
// Fail before packaging if a shipped module depends on an omitted local file.
for (const file of files.filter(name => /\.m?js$/.test(name))) {
  const source = readFileSync(new URL(file, root), 'utf8');
  const references = source.matchAll(/(?:from\s*|import\s*\(|new URL\s*\()\s*['"](\.\/[^'"]+)['"]/g);
  for (const match of references) {
    const dependency = match[1].slice(2);
    // Local credentials are intentionally supplied separately at runtime.
    if (dependency.startsWith('.env')) continue;
    if (!files.includes(dependency)) throw new Error(`Missing release dependency: ${file} -> ${dependency}`);
  }
}
const target = 'hang-up-meter-source-candidate.tar.gz';
execFileSync('/usr/bin/tar', ['-czf', target, '--', ...files], { cwd: fileURLToPath(root), env: { ...process.env, COPYFILE_DISABLE: '1' } });
console.log(JSON.stringify({ archive: target, files: files.length, published: false, keyFileIncluded: false }));
