import { classifyRound, digitsFromBeaconHex, pulseIndexAtTarget, scheduleRound } from './random.js';

const API = 'https://beacon.nist.gov/beacon/2.0';
const CHAIN = 2;
const $ = (selector) => document.querySelector(selector);
const els = {
  roundId: $('#round-id'), countdown: $('#countdown'), clockLabel: $('#clock-label'),
  open: $('#open-time'), close: $('#close-time'), pulse: $('#pulse-time'),
  panel: $('#prediction-panel'), lock: $('#lock-picks'), pickStatus: $('#pick-status'),
  shotStatus: $('#shot-status'), shotCards: $('#shot-cards'), arrows: $('#arrows'),
  resultPanel: $('#result-panel'), total: $('#total-score'), tags: $('#result-tags'),
  predictionResult: $('#prediction-result'), proof: $('#proof-content'),
};
const round = scheduleRound(Date.now());
let baselinePulse;
let picksLocked = false;
let resolved = false;
let apiRetries = 0;
let pollTimer;
let selectedPicks = {};

function timeKorea(timestamp, withSeconds = true) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}), hour12: false,
  }).format(new Date(timestamp));
}
function localRoundId(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `BA-${value.year}${value.month}${value.day}-${value.hour}${value.minute}`;
}
function updateTimes() {
  els.roundId.textContent = localRoundId(round.openAt);
  els.open.textContent = timeKorea(round.openAt);
  els.close.textContent = timeKorea(round.closesAt);
  els.pulse.textContent = timeKorea(round.pulseAt);
}
function getPicks() {
  return {
    parity: document.querySelector('input[name="parity"]:checked')?.value,
    range: document.querySelector('input[name="range"]:checked')?.value,
    combo: document.querySelector('input[name="combo"]:checked')?.value,
  };
}
function completePicks(picks) {
  return Boolean(picks.parity && picks.range && picks.combo);
}
function lockPicks(automatic = false) {
  if (picksLocked) return;
  selectedPicks = getPicks();
  picksLocked = true;
  document.querySelectorAll('input[name="parity"],input[name="range"],input[name="combo"]').forEach((input) => { input.disabled = true; });
  els.lock.disabled = true;
  els.lock.textContent = '예측 잠김';
  if (!completePicks(selectedPicks)) {
    els.pickStatus.textContent = automatic ? '마감되었습니다. 예측을 확정하지 않았어요.' : '세 항목 모두 선택 후 다시 확정해 주세요.';
    els.pickStatus.classList.add('warning');
    els.shotStatus.textContent = '접수 마감 · 지정 펄스 대기';
  } else {
    els.pickStatus.textContent = '예측이 잠겼습니다. 결과 공개를 기다려 주세요.';
    els.shotStatus.textContent = '접수 마감 · 펄스 생성 대기';
  }
  els.panel.classList.add('locked');
}
function updatePickButton() {
  if (picksLocked) return;
  const complete = completePicks(getPicks());
  els.lock.disabled = !complete || Date.now() >= round.closesAt;
  els.pickStatus.textContent = complete ? '선택을 마쳤어요. 마감 전에 확정할 수 있습니다.' : '세 항목을 모두 선택해 주세요.';
}
function tick() {
  const now = Date.now();
  if (!picksLocked && now >= round.closesAt) lockPicks(true);
  if (now < round.closesAt) {
    const remaining = round.closesAt - now;
    const seconds = Math.ceil(remaining / 1000);
    els.countdown.textContent = `00:${String(seconds).padStart(2, '0')}`;
    els.clockLabel.textContent = '선택 마감까지';
  } else if (now < round.pulseAt) {
    els.countdown.textContent = `00:${String(Math.ceil((round.pulseAt - now) / 1000)).padStart(2, '0')}`;
    els.clockLabel.textContent = '펄스 생성까지';
  } else if (!resolved) {
    els.countdown.textContent = '조회 중';
    els.clockLabel.textContent = '대상 펄스';
    if (!pollTimer && baselinePulse) pollForTargetPulse();
  }
}
function validatePulseResponse(body, expectedTime = null) {
  const pulse = body?.pulse;
  if (!pulse || pulse.statusCode !== 0 || pulse.chainIndex !== CHAIN || !Number.isInteger(pulse.pulseIndex) || !pulse.timeStamp || !/^[0-9a-f]+$/i.test(pulse.localRandomValue ?? '')) {
    throw new Error('비컨 응답의 필수 필드가 없거나 상태 코드가 정상(0)이 아닙니다.');
  }
  if (expectedTime !== null && Date.parse(pulse.timeStamp) !== expectedTime) {
    throw new Error(`지정 시각 펄스와 응답 시각이 다릅니다. 응답: ${pulse.timeStamp}`);
  }
  return pulse;
}
async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`NIST 응답 오류 (HTTP ${response.status})`);
  return response.json();
}
async function loadBaseline() {
  try {
    els.shotStatus.textContent = '공식 비컨 연결 확인 중';
    const body = await getJson(`${API}/pulse/last`);
    baselinePulse = validatePulseResponse(body);
    const expectedIndex = pulseIndexAtTarget(baselinePulse, round.pulseAt);
    els.proof.innerHTML = `<span class="muted">대상 시각 ${timeKorea(round.pulseAt)} KST · 펄스 #${expectedIndex}를 기다립니다.</span>`;
    els.shotStatus.textContent = Date.now() >= round.closesAt ? '접수 마감 · 지정 펄스 대기' : '예측 접수 중';
    tick();
  } catch (error) {
    showError(`NIST 비컨에 연결하지 못했습니다: ${error.message}`, true);
  }
}
function showError(message, retry = false) {
  els.shotStatus.textContent = '펄스 조회 오류';
  els.proof.innerHTML = `<span class="error-text">${escapeHtml(message)}</span>${retry ? ' <button id="retry-beacon" class="button retry">다시 연결</button>' : ''}`;
  $('#retry-beacon')?.addEventListener('click', () => { els.proof.textContent = 'NIST 비컨에 다시 연결하는 중…'; loadBaseline(); });
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function pollForTargetPulse() {
  if (resolved || pollTimer || !baselinePulse) return;
  const delay = Math.max(0, round.pulseAt - Date.now());
  pollTimer = window.setTimeout(async () => {
    pollTimer = undefined;
    try {
      const pulseIndex = pulseIndexAtTarget(baselinePulse, round.pulseAt);
      const body = await getJson(`${API}/chain/${CHAIN}/pulse/${pulseIndex}`);
      const pulse = validatePulseResponse(body, round.pulseAt);
      if (pulse.pulseIndex !== pulseIndex) throw new Error('펄스 번호가 기준 계산과 일치하지 않습니다.');
      resolved = true;
      els.shotStatus.textContent = `펄스 #${pulse.pulseIndex} 확인 · 세 발 발사`;
      els.countdown.textContent = '완료';
      await revealRound(pulse);
    } catch (error) {
      apiRetries += 1;
      if (apiRetries < 20) {
        els.shotStatus.textContent = `지정 펄스 재조회 중 (${apiRetries}/20)`;
        pollTimer = window.setTimeout(() => { pollTimer = undefined; pollForTargetPulse(); }, 3000);
      } else {
        showError(`지정 펄스를 확인하지 못했습니다. 다른 펄스로 대체하지 않았습니다. 원인: ${error.message}`);
      }
    }
  }, delay);
}
function predictionLabels(outcome) {
  return {
    parity: outcome.parity === 'odd' ? '홀수' : '짝수',
    range: outcome.range === 'under' ? '언더' : outcome.range === 'over' ? '오버' : '정확히 17',
    combo: outcome.combo === 'pair' ? '페어' : outcome.combo === 'triple' ? '트리플' : '모두 다름',
  };
}
function renderPredictionResult(outcome) {
  if (!completePicks(selectedPicks)) {
    els.predictionResult.textContent = '확정된 예측이 없어 결과만 공개합니다.';
    return;
  }
  const actual = predictionLabels(outcome);
  const checks = ['parity', 'range', 'combo'].map((key) => {
    const isWin = selectedPicks[key] === outcome[key];
    const name = key === 'parity' ? '홀짝' : key === 'range' ? '구간' : '조합';
    return `<span class="${isWin ? 'win' : 'miss'}">${name} ${isWin ? '적중' : '불일치'} (${actual[key]})</span>`;
  });
  els.predictionResult.innerHTML = checks.join('<br>');
}
function comboName(value) { return value === 'pair' ? '페어' : value === 'triple' ? '트리플' : '모두 다름'; }
function rangeName(value) { return value === 'under' ? '언더' : value === 'over' ? '오버' : '정확히 17'; }
async function revealRound(pulse) {
  const converted = digitsFromBeaconHex(pulse.localRandomValue, 3);
  const outcome = classifyRound(converted.digits);
  const cards = [...els.shotCards.children];
  for (let index = 0; index < converted.digits.length; index += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, index === 0 ? 350 : 850));
    const digit = converted.digits[index];
    const score = outcome.scores[index];
    const card = cards[index];
    card.classList.add('hit');
    card.querySelector('b').textContent = String(digit);
    card.querySelector('small').textContent = digit === 0 ? '10점 · 골드' : `${score}점`;
    const pin = document.createElement('span');
    pin.className = 'arrow-pin';
    pin.textContent = digit === 0 ? '10' : String(digit);
    const radius = (10 - score) * 4.3;
    const angle = -90 + index * 120;
    pin.style.left = `${50 + radius * Math.cos(angle)}%`;
    pin.style.top = `${50 + radius * Math.sin(angle)}%`;
    pin.style.animationDelay = '30ms';
    els.arrows.append(pin);
    requestAnimationFrame(() => pin.classList.add('show'));
  }
  els.total.textContent = String(outcome.total);
  els.tags.innerHTML = [
    `<span class="result-tag accent">${outcome.parity === 'odd' ? '홀수' : '짝수'}</span>`,
    `<span class="result-tag">${rangeName(outcome.range)}</span>`,
    `<span class="result-tag">${comboName(outcome.combo)}</span>`,
  ].join('');
  els.resultPanel.classList.remove('hidden');
  renderPredictionResult(outcome);
  const bytes = converted.used.map((byte, i) => `#${byte.index} ${byte.hex} → ${byte.digit}`).join(' · ');
  const skipped = converted.skipped.length ? ` · 건너뜀 ${converted.skipped.map((byte) => `#${byte.index} ${byte.hex}`).join(', ')}` : '';
  const uri = pulse.uri || `${API}/chain/${CHAIN}/pulse/${pulse.pulseIndex}`;
  els.proof.innerHTML = `<div><a href="${escapeHtml(uri)}" target="_blank" rel="noopener noreferrer">NIST 원본 펄스 #${pulse.pulseIndex} ↗</a> · ${escapeHtml(pulse.timeStamp)} UTC · ${timeKorea(Date.parse(pulse.timeStamp))} KST</div><details><summary>난수값과 변환 바이트 보기</summary><code>${escapeHtml(pulse.localRandomValue)}</code><div>${escapeHtml(bytes + skipped)}</div></details>`;
  els.shotStatus.textContent = '세 발 결과 공개 완료';
}

document.querySelectorAll('input[name="parity"],input[name="range"],input[name="combo"]').forEach((input) => input.addEventListener('change', updatePickButton));
els.lock.addEventListener('click', () => {
  if (!completePicks(getPicks()) || Date.now() >= round.closesAt) return;
  lockPicks(false);
});
updateTimes();
window.setInterval(tick, 250);
loadBaseline();
