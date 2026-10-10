import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AUDA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-proxmox-test-'));
const { putSecret } = await import('../src/secrets/broker.ts');
const { request, awaitTask } = await import('../src/connectors/proxmox.ts');
const config = { url: 'https://pve.local:8006', tokenId: 'auda@pve!agent', secretRef: putSecret('test-token','secret'), node: 'pve', template: 9000 };
const original = globalThis.fetch;
test('Proxmox sends API token without exposing it in URL', async () => {
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://pve.local:8006/api2/json/nodes');
      assert.equal(new Headers(init?.headers).get('authorization'), 'PVEAPIToken=auda@pve!agent=secret');
      return new Response(JSON.stringify({ data: [{node:'pve',status:'online'}] }), {status:200});
    };
    assert.deepEqual(await request(config,'GET','/nodes'),[{node:'pve',status:'online'}]);
  } finally { globalThis.fetch = original; }
});
test('UPID wait checks successful completion', async () => {
  try {
    let n = 0;
    globalThis.fetch = async () => new Response(JSON.stringify({data: ++n >= 2 ? {status:'stopped',exitstatus:'OK'} : {status:'running'}}),{status:200});
    await awaitTask(config,'pve','UPID:abc',4000);
    assert.equal(n,2);
  } finally { globalThis.fetch = original; }
});
test('UPID wait rejects failed clone', async () => {
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({data:{status:'stopped',exitstatus:'ERROR'}}),{status:200});
    await assert.rejects(awaitTask(config,'pve','UPID:abc',4000),/task failed/);
  } finally { globalThis.fetch = original; }
});
test('UPID format validated before sending requests', async () => {
  await assert.rejects(awaitTask(config,'pve','not-an-upid'),/Expected Proxmox UPID/);
});
