export const BYTE_LIMIT = 250;

export function digitsFromBeaconHex(hex, count = 3) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new TypeError('난수값은 짝수 길이의 16진수 문자열이어야 합니다.');
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('생성할 숫자 개수는 양의 정수여야 합니다.');
  }

  const digits = [];
  const used = [];
  const skipped = [];
  for (let offset = 0; offset < hex.length && digits.length < count; offset += 2) {
    const byte = Number.parseInt(hex.slice(offset, offset + 2), 16);
    const index = offset / 2;
    if (byte >= BYTE_LIMIT) {
      skipped.push({ index, hex: hex.slice(offset, offset + 2).toUpperCase(), value: byte });
      continue;
    }
    const digit = byte % 10;
    digits.push(digit);
    used.push({ index, hex: hex.slice(offset, offset + 2).toUpperCase(), value: byte, digit });
  }
  if (digits.length !== count) {
    throw new RangeError(`난수값에서 숫자 ${count}개를 만들 바이트가 부족합니다.`);
  }
  return { digits, used, skipped };
}

export function scoreDigit(digit) {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) throw new RangeError('화살 숫자는 0~9여야 합니다.');
  return digit === 0 ? 10 : digit;
}

export function classifyRound(digits) {
  if (!Array.isArray(digits) || digits.length !== 3) throw new RangeError('양궁 결과는 숫자 세 개여야 합니다.');
  const scores = digits.map(scoreDigit);
  const total = scores.reduce((sum, score) => sum + score, 0);
  const counts = new Map();
  for (const digit of digits) counts.set(digit, (counts.get(digit) ?? 0) + 1);
  const maxCount = Math.max(...counts.values());
  const combo = maxCount === 3 ? 'triple' : maxCount === 2 ? 'pair' : 'none';
  return {
    scores,
    total,
    parity: total % 2 === 0 ? 'even' : 'odd',
    range: total < 17 ? 'under' : total === 17 ? 'push' : 'over',
    combo,
  };
}

export function scheduleRound(nowMs) {
  const minute = 60_000;
  let openAt = Math.floor(nowMs / minute) * minute;
  let closesAt = openAt + 50_000;
  if (nowMs >= closesAt) {
    openAt += minute;
    closesAt += minute;
  }
  const pulseAt = Math.ceil((closesAt + 1) / minute) * minute;
  return { openAt, closesAt, pulseAt };
}

export function pulseIndexAtTarget(baselinePulse, targetAt) {
  if (!baselinePulse?.timeStamp || !Number.isInteger(baselinePulse.pulseIndex)) {
    throw new TypeError('기준 펄스에 시각 또는 번호가 없습니다.');
  }
  const baselineAt = Date.parse(baselinePulse.timeStamp);
  const period = baselinePulse.period;
  if (!Number.isFinite(baselineAt) || !Number.isFinite(period) || period <= 0) {
    throw new TypeError('기준 펄스의 시각 또는 주기가 올바르지 않습니다.');
  }
  const intervals = (targetAt - baselineAt) / period;
  const rounded = Math.round(intervals);
  if (rounded < 0 || Math.abs(intervals - rounded) > 0.001) {
    throw new RangeError('대상 펄스를 기준 펄스와 주기로 정확히 계산할 수 없습니다.');
  }
  return baselinePulse.pulseIndex + rounded;
}
