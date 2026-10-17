import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const agentSha = 'a'.repeat(40), oldHead = 'b'.repeat(40), olderAgent = 'c'.repeat(40);
// Network interception uses a POSIX executable fixture; Windows has a separate
// Git Bash installer/update smoke suite.
for (const scenario of ['current', 'legacy-marker', 'updated', 'malformed', 'empty', 'network-error']) {
  test(`updater: ${scenario}`, { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-update-test-'));
    try {
      const runtime = join(root, 'runtime'), bin = join(root, 'bin');
      await mkdir(runtime); await mkdir(bin);
      for (const name of ['update-commands.sh', 'ctl-lib.sh']) await cp(new URL(name, import.meta.url), join(runtime, name));
      const current = scenario === 'legacy-marker' ? oldHead : scenario === 'updated' ? olderAgent : agentSha;
      await writeFile(join(runtime, '.script-toolbox-agent-runtime'), `release_id=${current}\n`);
      const log = join(root, 'requests');
      await writeFile(join(bin, 'curl'), `#!/usr/bin/env node
const fs=require('fs'), args=process.argv.slice(2), url=args.find(a=>a.startsWith('https:'));
fs.appendFileSync(${JSON.stringify(log)}, url+'\\n');
if (${JSON.stringify(scenario)}==='network-error') process.exit(22);
if (!url.includes('path=agent&per_page=1')) process.exit(23);
const sha=url.includes('sha=${olderAgent}')?'${olderAgent}':'${agentSha}';
fs.writeFileSync(args[args.indexOf('-o')+1], ${JSON.stringify(scenario)}==='malformed'?'{}':${JSON.stringify(scenario)}==='empty'?'[]':JSON.stringify([{sha}]));
`, {mode: 0o700});
      const result = spawnSync('bash', [join(runtime, 'update-commands.sh'), '--check'], {
        encoding: 'utf8', env: {...process.env, PATH: `${bin}:${process.env.PATH}`},
      });
      if (['malformed', 'empty', 'network-error'].includes(scenario)) assert.notEqual(result.status, 0);
      else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, scenario === 'updated' ? /update is available/ : /already current/);
      }
      const requests = await readFile(log, 'utf8');
      assert.match(requests, /commits\?sha=main&path=agent&per_page=1/);
      assert.doesNotMatch(requests, /archive/);
      if (scenario === 'legacy-marker') assert.match(requests, new RegExp(`sha=${oldHead}&path=agent`));
    } finally { await rm(root, {recursive: true, force: true}); }
  });
}
