// The codec, pinned to bytes seen in real controller <-> AD4Q traffic. If one
// of these changes, the unit will stop answering without an error.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMIT_PDU,
  DMP,
  buildWrapper,
  clientBlock,
  dmpBatch,
  dmpPdu,
  mgmtAck,
  parseDmp,
  strBatch,
  parseWrapper,
  pduDecode,
  pduEncode,
  rootParse,
  sdtMessages,
} from '../driver/acn/pdu.js';
import { buildAttrRply, buildSrvRqst, parseAttrRply } from '../driver/acn/slp.js';
import { encodeString, decodeString, chanAddr, splitAddr } from '../driver/ad4q/properties.js';

const hex = (buf) => buf.toString('hex');
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

test('the protocol declare is the bytes the unit expects', () => {
  // controller -> unit: "I want protocol 2", association 0, in a protocol-1 block
  const declare = clientBlock(1, 1, 0, pduEncode(0x09, null, u32(2)));
  assert.equal(hex(declare), '70110001000000010000' + '70070900000002');
});

test('a plain DMP block carries association 0 and protocol 2', () => {
  const block = clientBlock(1, 2, 0, dmpPdu(DMP.GET, 0x02000128));
  assert.equal(hex(block), '7012' + '0001' + '00000002' + '0000' + '700801' + '02' + '02000128');
});

test('a SET is followed by the fixed commit PDU in the same payload', () => {
  const set = dmpPdu(DMP.SET, 0x02000128, Buffer.from([0xc4]));
  assert.equal(hex(set), '70090202' + '02000128' + 'c4');
  assert.equal(hex(COMMIT_PDU), '7005010000');
  const block = clientBlock(1, 2, 0, Buffer.concat([set, COMMIT_PDU]));
  assert.equal(hex(block), '7018' + '0001' + '00000002' + '0000' + hex(set) + '7005010000');
});

test('a management ack names the last reliable sequence seen', () => {
  assert.equal(hex(mgmtAck(0x1234)), '70070e00001234');
});

test('dmp values parse, including continuation PDUs that inherit the vector', () => {
  const payload = Buffer.concat([
    Buffer.from('70090302' + '02000102' + '05', 'hex'), // GET_REPLY addr value=05
    Buffer.from('1007' + '02000104' + '01', 'hex'), // continuation, same vector
  ]);
  assert.deepEqual(
    parseDmp(payload).map((p) => [p.vector, p.addr, hex(p.value)]),
    [
      [DMP.GET_REPLY, 0x02000102, '05'],
      [DMP.GET_REPLY, 0x02000104, '01'],
    ]
  );
});

test('the AD4D\'s answer to a committed SET names no address, and parses as one with a null address', () => {
  // as captured from an AD4D: GET_FAIL, no-address header, code 0001
  const reply = Buffer.from('700609000001', 'hex');
  assert.deepEqual(
    parseDmp(reply).map((p) => [p.vector, p.addr, hex(p.value)]),
    [[DMP.GET_FAIL, null, '0001']]
  );
  // and the commit PDU we send, which has the same shape but only five bytes, is not mistaken for one
  assert.deepEqual(parseDmp(COMMIT_PDU), []);
});

// Bytes below are from a Wireless Workbench scan of an AD4D (channel 1, antenna A).
const WWB_SCAN_CONFIG = Buffer.from(
  '702d0207002552465f5343414e3a5343414e5f53544152545f465245512f43483d302f5343414e3d3000072c6d' +
    '102a002452465f5343414e3a5343414e5f53544f505f465245512f43483d302f5343414e3d3000094683' +
    '102a002452465f5343414e3a5343414e5f535445505f465245512f43483d302f5343414e3d3000000019' +
    '102e002852465f5343414e3a5343414e5f5245534f4c5554494f4e5f42572f43483d302f5343414e3d30000000c8' +
    '102c002952465f5343414e3a5343414e5f5245504541545f524551554553542f43483d302f5343414e3d3001' +
    '1028002252465f5343414e3a43555256455f53454c4543542f43483d302f5343414e3d3000000002',
  'hex'
);

test('the scan configuration is written as Wireless Workbench writes it, byte for byte', () => {
  const be32 = (n) => Buffer.from([n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const built = strBatch(DMP.SET, [
    { key: 'RF_SCAN:SCAN_START_FREQ/CH=0/SCAN=0', value: be32(470125) },
    { key: 'RF_SCAN:SCAN_STOP_FREQ/CH=0/SCAN=0', value: be32(607875) },
    { key: 'RF_SCAN:SCAN_STEP_FREQ/CH=0/SCAN=0', value: be32(25) },
    { key: 'RF_SCAN:SCAN_RESOLUTION_BW/CH=0/SCAN=0', value: be32(200) },
    { key: 'RF_SCAN:SCAN_REPEAT_REQUEST/CH=0/SCAN=0', value: Buffer.from([1]) },
    { key: 'RF_SCAN:CURVE_SELECT/CH=0/SCAN=0', value: be32(2) },
  ]);
  assert.equal(hex(built), hex(WWB_SCAN_CONFIG));
});

test('string-keyed PDUs parse, continuation PDUs included', () => {
  const entries = parseDmp(WWB_SCAN_CONFIG);
  assert.deepEqual(
    entries.map((e) => [e.vector, e.addr, e.key, hex(e.value)]),
    [
      [DMP.SET, null, 'RF_SCAN:SCAN_START_FREQ/CH=0/SCAN=0', '00072c6d'],
      [DMP.SET, null, 'RF_SCAN:SCAN_STOP_FREQ/CH=0/SCAN=0', '00094683'],
      [DMP.SET, null, 'RF_SCAN:SCAN_STEP_FREQ/CH=0/SCAN=0', '00000019'],
      [DMP.SET, null, 'RF_SCAN:SCAN_RESOLUTION_BW/CH=0/SCAN=0', '000000c8'],
      [DMP.SET, null, 'RF_SCAN:SCAN_REPEAT_REQUEST/CH=0/SCAN=0', '01'],
      [DMP.SET, null, 'RF_SCAN:CURVE_SELECT/CH=0/SCAN=0', '00000002'],
    ]
  );
});

test('a sample chunk from the unit is an EVENT keyed with the indices it covers', () => {
  const chunk = Buffer.from(
    '70650407003a2652465f5343414e5f444154413a525353492f43483d302f5343414e3d302f43555256455f4944583d312f' +
      '465245515f4944583d352d3230' +
      '002700000010' +
      '02fc4dfc2bfc24fc24fc19fc26fc1efc1cfc1bfc1dfc21fc24fc42fc65fc70fc79',
    'hex'
  );
  const [event] = parseDmp(chunk);
  assert.equal(event.vector, DMP.EVENT);
  assert.equal(event.key, '&RF_SCAN_DATA:RSSI/CH=0/SCAN=0/CURVE_IDX=1/FREQ_IDX=5-20');
  assert.equal(event.value.readUInt16BE(0), 0x27);
  assert.equal(event.value.readUInt32BE(2), 16);
});

test('a batch is one full PDU and one continuation PDU per further address', () => {
  const batch = dmpBatch(DMP.GET, [0x02000102, 0x02000104, 0x02000114]);
  assert.equal(hex(batch), '7008' + '0102' + '02000102' + '1006' + '02000104' + '1006' + '02000114');
  assert.deepEqual(parseDmp(batch).map((p) => p.addr), [0x02000102, 0x02000104, 0x02000114]);
});

test('a PDU decodes its own length, in both the 12-bit and 20-bit forms', () => {
  const short = pduEncode(7, null, Buffer.from([1, 2, 3]));
  assert.deepEqual(pduDecode(short, 0), { flags: 7, dataStart: 2, end: short.length });
  const long = dmpPdu(DMP.SET, 0x01000012, Buffer.alloc(5000));
  const decoded = pduDecode(long, 0);
  assert.equal(decoded.flags & 0x8, 0x8);
  assert.equal(decoded.end, long.length);
});

test('a wrapper survives a round trip through the root layer', () => {
  const cid = Buffer.alloc(16, 0xab);
  const block = clientBlock(1, 2, 0, dmpPdu(DMP.GET, 0x02010102));
  const packet = buildWrapper(cid, 0x8010, 7, 0x8011, 0x8011, [block], true);
  const root = rootParse(packet);
  assert.equal(hex(root.cid), hex(cid));
  const [message] = [...sdtMessages(root.sdt)];
  assert.equal(message.vector, 1);
  const wrapper = parseWrapper(message.data);
  assert.equal(wrapper.chan, 0x8010);
  assert.equal(wrapper.rel, 0x8011);
  assert.equal(wrapper.blocks.length, 1);
  assert.equal(wrapper.blocks[0].proto, 2);
  assert.deepEqual(parseDmp(wrapper.blocks[0].payload).map((p) => p.addr), [0x02010102]);
});

test('strings carry a two-byte length that counts itself', () => {
  assert.equal(hex(encodeString('AD4Q-C')), '0008' + Buffer.from('AD4Q-C').toString('hex'));
  assert.equal(hex(encodeString('Channel1')), '000a' + Buffer.from('Channel1').toString('hex'));
  assert.equal(decodeString(encodeString('Test A')), 'Test A');
  assert.equal(decodeString(Buffer.from([0x00, 0x09, 0x41])), null, 'a wrong length is not a string');
});

test('channel addresses are 0x02, channel index, then the object', () => {
  assert.equal(chanAddr(1, 0x0128), 0x02000128);
  assert.equal(chanAddr(3, 0x0804), 0x02020804);
  assert.deepEqual(splitAddr(0x02030102), { channel: 4, obj: 0x0102 });
  assert.equal(splitAddr(0x01000000), null);
  assert.equal(chanAddr(24, 0x0001), 0x02170001, 'an ANX4 goes to 24 channels');
  assert.throws(() => chanAddr(25, 0x0102), RangeError);
});

test('an SLP advert parses into the unit it describes, and back', () => {
  const cid = Buffer.from('dd4a8fcf000011dda000000eddcccccc', 'hex');
  const unit = parseAttrRply(buildAttrRply({ cid, fctn: 'AD4Q_RX', uacn: 'AD4Q C', ip: '169.254.77.141', port: 57383 }));
  assert.deepEqual(unit, {
    cid: 'dd4a8fcf000011dda000000eddcccccc',
    cidText: 'DD4A8FCF-0000-11DD-A000-000EDDCCCCCC',
    fctn: 'AD4Q_RX',
    uacn: 'AD4Q C',
    ip: '169.254.77.141',
    port: 57383,
  });
  assert.equal(parseAttrRply(buildSrvRqst()), null, 'a request is not an advert');
});
