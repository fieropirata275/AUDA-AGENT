/**
 * LAN discovery, so the mobile app finds AUDA instances by itself:
 *  - mDNS / DNS-SD: advertises `_auda._tcp` (Android NsdManager, Bonjour);
 *  - UDP fallback on port 4611 for networks that block multicast: a client
 *    broadcasts "AUDA_DISCOVER" and every instance answers with its card;
 *  - GET /api/discover: the same card over HTTP (used for subnet scans and
 *    to confirm a found instance).
 * The card contains no secrets: id, name, version, port, whether pairing is required.
 */
import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { Bonjour } from 'bonjour-service';
import { config } from '../core/config.ts';
import { getSetting, setSetting, q } from '../core/db.ts';
import { log } from '../core/log.ts';
import { system } from '../core/system.ts';

export const VERSION = '0.3.0';
export const DISCOVERY_PORT = Number(process.env.AUDA_DISCOVERY_PORT ?? 4611);

export function instanceId(): string {
  let id = getSetting<string>('instance.id', '');
  if (!id) { id = crypto.randomBytes(8).toString('hex'); setSetting('instance.id', id); }
  return id;
}
export const instanceName = () => getSetting<string>('instance.name', `AUDA on ${os.hostname()}`);
export const requiresPairing = () => Boolean(process.env.AUDA_TOKEN) || getSetting('security.requirePairing', false);

export function card() {
  const ident = q.get('SELECT presence, narration FROM identity LIMIT 1');
  return {
    service: 'auda', id: instanceId(), name: instanceName(), version: VERSION, port: config.port,
    requiresPairing: requiresPairing(), presence: ident?.presence ?? 'available', narration: ident?.narration ?? '', safeMode: system.safeMode,
  };
}

let bonjour: Bonjour | null = null;
let udp: dgram.Socket | null = null;

export function startDiscovery() {
  if (process.env.AUDA_DISCOVERY === '0') return;
  try {
    bonjour = new Bonjour();
    bonjour.publish({ name: `${instanceName()} (${instanceId().slice(0, 4)})`, type: 'auda', port: config.port, txt: { id: instanceId(), name: instanceName(), version: VERSION, pairing: requiresPairing() ? '1' : '0', path: '/' } });
  } catch (e) { log.warn('mDNS advertising unavailable', String(e)); }
  try {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('message', (msg, rinfo) => {
      if (!msg.toString('utf8').startsWith('AUDA_DISCOVER')) return;
      const reply = Buffer.from(JSON.stringify({ ...card(), addresses: lanAddresses() }));
      udp?.send(reply, rinfo.port, rinfo.address);
    });
    udp.on('error', (e) => log.warn('UDP discovery error', String(e)));
    udp.bind(DISCOVERY_PORT, () => { try { udp?.setBroadcast(true); } catch { /* ignore */ } });
  } catch (e) { log.warn('UDP discovery unavailable', String(e)); }
}

export function stopDiscovery() {
  try { bonjour?.unpublishAll(); bonjour?.destroy(); } catch { /* ignore */ }
  try { udp?.close(); } catch { /* ignore */ }
}

export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
}
