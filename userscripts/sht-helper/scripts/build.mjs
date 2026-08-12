import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadataPath = join(root, 'src', 'metadata.user.js');
const modulesDir = join(root, 'src', 'modules');
const outputPath = join(root, 'sht-helper.user.js');
const checkOnly = process.argv.includes('--check');

const moduleNames = (await readdir(modulesDir))
    .filter(name => name.endsWith('.js'))
    .sort((a, b) => a.localeCompare(b, 'en'));
if (!moduleNames.length) throw new Error('No source modules found.');

const parts = [await readFile(metadataPath, 'utf8')];
for (const name of moduleNames) parts.push(await readFile(join(modulesDir, name), 'utf8'));
const generated = parts.map(part => part.trimEnd()).join('\n\n') + '\n';
const metadataVersion = parts[0].match(/^\/\/ @version\s+(\S+)/m)?.[1];
const runtimeVersion = generated.match(/const SCRIPT_VERSION = '([^']+)'/)?.[1];
if (!metadataVersion || metadataVersion !== runtimeVersion) {
    throw new Error(`Version mismatch: metadata=${metadataVersion || 'missing'}, runtime=${runtimeVersion || 'missing'}`);
}
if (!generated.trimEnd().endsWith('})();')) throw new Error('Generated userscript is missing the closing IIFE.');

if (checkOnly) {
    const current = await readFile(outputPath, 'utf8');
    if (current !== generated) {
        console.error('sht-helper.user.js is stale. Run: npm run build');
        process.exitCode = 1;
    } else {
        console.log(`Generated userscript is current (${moduleNames.length} modules).`);
    }
} else {
    await writeFile(outputPath, generated);
    console.log(`Built ${outputPath} from ${moduleNames.length} modules.`);
}
