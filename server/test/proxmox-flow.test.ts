/** Simulated Proxmox integration: creation -> start -> command -> suspend -> resume. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.AUDA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'auda-pve-flow-'));
const P = await import('../src/connectors/proxmox.ts');
const realFetch = globalThis.fetch;
test('agent VM provision, guest operation, suspend and resume (simulated API)', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)), pathname = url.pathname.replace('/api2/json','');
    calls.push(String(options?.method ?? 'GET')+' '+pathname);
    let data: any = null;
    if(pathname === '/nodes') data = [{node:'pve',status:'online'}];
    else if(pathname === '/cluster/resources') data = [{type:'qemu',template:1,node:'pve',vmid:9000}];
    else if(pathname === '/cluster/nextid') data = '101';
    else if(pathname.includes('/tasks/') && pathname.endsWith('/status')) data = {status:'stopped',exitstatus:'OK'};
    else if(pathname.endsWith('/agent/exec')) data = {pid:42};
    else if(pathname.endsWith('/agent/exec-status')) data = {exited:true,exitcode:0,'out-data':Buffer.from('hello').toString('base64'),'err-data':''};
    else if(pathname.endsWith('/status/current')) data = {status:'stopped',qmpstatus:'stopped'};
    else if(pathname.endsWith('/clone') || pathname.includes('/status/start') || pathname.includes('/status/suspend') || pathname.includes('/status/resume')) data = 'UPID:fake';
    else if(pathname.endsWith('/config')) data = null;
    else throw Error('Unexpected Proxmox route '+pathname);
    return new Response(JSON.stringify({data}),{status:200,headers:{'content-type':'application/json'}});
  };
  try {
    const linked = await P.connect({url:'https://pve.example:8006',tokenId:'auda@pve!agent',tokenSecret:'secret'});
    assert.equal(linked.template,9000);
    const vm = await P.ensureAgentVm('agent-one');
    assert.equal(vm.vmid,101);
    const r = await P.runInVm('agent-one','printf hello');
    assert.equal(r.stdout,'hello');
    await P.parkAgentVm('agent-one');
    assert.equal((await P.ensureAgentVm('agent-one')).state,'running');
    assert.ok(calls.some(x=>x.includes('/clone')));
    assert.ok(calls.some(x=>x.includes('/status/suspend')));
    assert.ok(calls.some(x=>x.includes('/status/resume')));
    assert.equal(calls.filter(x=>x.includes('/clone')).length,1);
  } finally { globalThis.fetch = realFetch; }
});
