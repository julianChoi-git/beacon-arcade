import test from 'node:test';
import assert from 'node:assert/strict';
import { BYTE_LIMIT, classifyRound, digitsFromBeaconHex, pulseIndexAtTarget, scheduleRound, scoreDigit } from '../src/random.js';

test('0~249 바이트는 나머지로 숫자를 만들고 거부 바이트는 건너뛴다', () => {
  const result = digitsFromBeaconHex('00F9FAFF35');
  assert.deepEqual(result.digits, [0, 9, 3]);
  assert.deepEqual(result.used.map(({ index }) => index), [0, 1, 4]);
  assert.deepEqual(result.skipped.map(({ index }) => index), [2, 3]);
  assert.equal(BYTE_LIMIT, 250);
});

test('유효한 모든 바이트 경계가 예상대로 변환되고 각 숫자가 같은 개수의 입력을 가진다', () => {
  assert.deepEqual(digitsFromBeaconHex('00F9', 2).digits, [0, 9]);
  assert.throws(() => digitsFromBeaconHex('FAFB', 1), /부족/);
  assert.throws(() => digitsFromBeaconHex('0'), /16진수/);
  assert.throws(() => digitsFromBeaconHex('GG'), /16진수/);
  const frequencies = Array(10).fill(0);
  for (let byte = 0; byte < 250; byte += 1) frequencies[digitsFromBeaconHex(byte.toString(16).padStart(2, '0'), 1).digits[0]] += 1;
  assert.deepEqual(frequencies, Array(10).fill(25));
});

test('0은 10점이고 총점 홀짝 및 언더/17/오버를 정확히 분류한다', () => {
  assert.equal(scoreDigit(0), 10);
  assert.equal(classifyRound([0, 1, 2]).total, 13);
  assert.deepEqual(classifyRound([0, 1, 2]), {
    scores: [10, 1, 2], total: 13, parity: 'odd', range: 'under', combo: 'none',
  });
  assert.equal(classifyRound([9, 5, 4]).range, 'over');
  assert.equal(classifyRound([9, 5, 4]).total, 18);
  assert.equal(classifyRound([9, 4, 4]).total, 17);
  assert.equal(classifyRound([9, 4, 4]).range, 'push');
  assert.equal(classifyRound([8, 8, 0]).range, 'over');
});

test('페어와 트리플 판정은 원래 숫자를 비교한다', () => {
  assert.equal(classifyRound([5, 1, 5]).combo, 'pair');
  assert.equal(classifyRound([0, 0, 0]).combo, 'triple');
  assert.equal(classifyRound([5, 1, 9]).combo, 'none');
  assert.throws(() => classifyRound([1, 2]), /세 개/);
});

test('라운드 접수는 정각 50초에 닫히고 그 이후 첫 정각 펄스를 대상으로 한다', () => {
  const minute = 60_000;
  const at = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.deepEqual(scheduleRound(at + 49_999), { openAt: at, closesAt: at + 50_000, pulseAt: at + minute });
  assert.deepEqual(scheduleRound(at + 50_000), { openAt: at + minute, closesAt: at + minute + 50_000, pulseAt: at + minute * 2 });
});

test('기준 펄스 번호에서 대상 펄스 번호를 주기로 계산한다', () => {
  const baseline = { pulseIndex: 100, timeStamp: '2026-01-01T00:00:00.000Z', period: 60_000 };
  assert.equal(pulseIndexAtTarget(baseline, Date.parse('2026-01-01T00:02:00.000Z')), 102);
  assert.throws(() => pulseIndexAtTarget(baseline, Date.parse('2026-01-01T00:02:30.000Z')), /정확히 계산/);
});
