export const nftFixture = JSON.stringify({ nftables: [
  { metainfo: { json_schema_version: 1 } },
  { table: { family: 'inet', name: 'filter' } },
  { chain: { family: 'inet', table: 'filter', name: 'input', type: 'filter', hook: 'input', prio: 0, policy: 'drop' } },
  { chain: { family: 'ip6', table: 'filter', name: 'input', policy: 'accept' } },
  { set: { family: 'inet', table: 'filter', name: 'trusted', type: 'ipv4_addr', elem: ['10.0.0.1'] } },
  { rule: { family: 'inet', table: 'filter', chain: 'input', handle: 8, comment: 'Allow SSH from trusted network', expr: [
    { match: { op: '!=', left: { payload: { protocol: 'ip', field: 'saddr' } }, right: { prefix: { addr: '192.0.2.0', len: 24 } } } },
    { match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: 22 } },
    { counter: { packets: 12, bytes: 2048 } }, { accept: null },
  ] } },
  { rule: { family: 'inet', table: 'filter', chain: 'input', expr: [{ match: { op: 'in', left: { ct: { key: 'state' } }, right: { set: ['established', 'related'] } } }, { jump: { target: 'trusted' } }] } },
  { rule: { family: 'ip6', table: 'filter', chain: 'input', expr: [{ drop: null }] } },
] });
