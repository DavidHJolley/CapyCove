import * as log from '../server/log.js';
import assert from 'node:assert/strict';

const lines = [];
let t = 1_700_000_000_000;
log.install({ write: (l) => lines.push(l), now: () => t, base: { pid: 42 }, level: 'debug' });

// 1. shape
log.info('ws.connect', { name: 'Bo', account: false, online: 3 });
const rec = JSON.parse(lines.at(-1));
assert.equal(rec.lvl, 'info');
assert.equal(rec.ev, 'ws.connect');
assert.equal(rec.pid, 42);
assert.equal(rec.name, 'Bo');
assert.equal(rec.online, 3);
assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);

// 2. redaction, at depth
log.warn('auth.try', { password: 'hunter2', deep: { token: 'abc', ok: 1 }, msg: 'hi there' });
const r2 = JSON.parse(lines.at(-1));
assert.equal(r2.password, '[redacted]');
assert.equal(r2.deep.token, '[redacted]');
assert.equal(r2.deep.ok, 1);
assert.equal(r2.msg, '[redacted]');

// 3. Errors keep name/message/stack head
log.error('fatal.uncaught', new TypeError('boom'));
const r3 = JSON.parse(lines.at(-1));
assert.equal(r3.name, 'TypeError');
assert.equal(r3.err, 'boom');
assert.ok(r3.at.includes('TypeError'));

// 4. level filtering
log.install({ write: (l) => lines.push(l), now: () => t, level: 'warn' });
const before = lines.length;
log.info('nope', {});
log.debug('nope2', {});
assert.equal(lines.length, before);
assert.equal(log.stats().log.belowLevel, 2);
log.error('yes', {});
assert.equal(lines.length, before + 1);

// 5. silent
log.install({ write: (l) => lines.push(l), now: () => t, level: 'silent' });
const b5 = lines.length;
log.error('quiet', {});
assert.equal(lines.length, b5);

// 6. burst suppression + rollover summary
log.install({ write: (l) => lines.push(l), now: () => t, level: 'debug', burst: 3, windowMs: 1000 });
const b6 = lines.length;
for (let i = 0; i < 10; i++) log.error('handler.throw', { i });
assert.equal(lines.length - b6, 3, 'only burst lines get through');
t += 2000;
log.error('handler.throw', { i: 99 });
const summary = JSON.parse(lines.at(-2));
assert.equal(summary.ev, 'log.suppressed');
assert.equal(summary.of, 'handler.throw');
assert.equal(summary.dropped, 7);
assert.equal(JSON.parse(lines.at(-1)).i, 99);

// 7. oversized line becomes a parseable stub
log.install({ write: (l) => lines.push(l), now: () => t, level: 'debug', maxLine: 300 });
log.info('big', { blob: 'x'.repeat(600) });
const r7 = JSON.parse(lines.at(-1));
assert.equal(r7.ev, 'big');
assert.ok(r7.cut > 300);
assert.equal(log.stats().log.trimmed, 1);

// 8. every line ever written parses as JSON
for (const l of lines) JSON.parse(l);

// 9. counters + health
log.install({ write: (l) => lines.push(l), now: () => t });
log.frameIn(); log.frameIn(); log.frameOut(5); log.frameDrop();
log.count('mural.op', 3); log.count('mural.op');
const h = log.health();
assert.deepEqual(h.frames, { in: 2, out: 5, dropped: 1 });
assert.equal(h.counters['mural.op'], 4);
assert.ok(h.memory.rss > 0 && h.uptime >= 0);
assert.equal(h.log.level, 'info');

// 10. child
const l = log.child({ mod: 'race' });
l.warn('start.failed', { err: 'nope' });
const r10 = JSON.parse(lines.at(-1));
assert.equal(r10.mod, 'race');
assert.equal(r10.err, 'nope');
l.child({ id: 7 }).info('sub');
assert.equal(JSON.parse(lines.at(-1)).id, 7);

// 11. reserved keys cannot be overwritten
log.info('x', { ev: 'spoof', ts: 'nope' });
const r11 = JSON.parse(lines.at(-1));
assert.equal(r11.ev, 'x');
assert.equal(r11._ev, 'spoof');

// 12. junk arguments never throw
log.info(null, null);
log.log('bogus-level', 'y', 'not-an-object');
const circ = { a: 1 }; circ.self = circ;
log.info('circular', circ);
assert.equal(JSON.parse(lines.at(-1)).ev, 'circular');

// 13. pretty mode
log.install({ write: (x) => lines.push(x), now: () => t, pretty: true, level: 'debug' });
log.info('ws.connect', { name: 'Bo', online: 3 });
assert.ok(lines.at(-1).includes('ws.connect name=Bo online=3'), lines.at(-1));

// 14. a throwing sink never throws at the call site
log.install({ write: () => { throw new Error('closed'); } });
log.info('into.the.void', { a: 1 });
assert.equal(log.stats().log.failed, 1);

console.log('log.js smoke: all 14 checks pass');

