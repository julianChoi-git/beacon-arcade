import { classifyRound, digitsFromBeaconHex, evaluatePicks, hasAnyPick, scheduleRound, targetPulsePlan } from './random.js';

const API = 'https://beacon.nist.gov/beacon/2.0';
const CHAIN = 2;
const HISTORY_KEY = 'beacon-archery-predictions-v1';
const POLL_INTERVAL_MS = 5_000;
const MAX_PULSE_RETRIES = 120;
const $ = (selector) => document.querySelector(selector);
const els = {
  roundId: $('#round-id'), countdown: $('#countdown'), clockLabel: $('#clock-label'),
  open: $('#open-time'), close: $('#close-time'), pulse: $('#pulse-time'),
  panel: $('#prediction-panel'), lock: $('#lock-picks'), pickStatus: $('#pick-status'),
  shotStatus: $('#shot-status'), shotCards: $('#shot-cards'), arrows: $('#arrows'),
  resultPanel: $('#result-panel'), total: $('#total-score'), tags: $('#result-tags'),
  predictionResult: $('#prediction-result'), proof: $('#proof-content'), history: $('#history-list'),
};
const round = scheduleRound(Date.now());
const roundId = localRoundId(round.openAt);
let history = readHistory();
let currentTicket = history.find((record) => record.roundId === roundId) ?? null;
let selectedPicks = currentTicket ? { ...currentTicket.picks } : {};
let picksLocked = Boolean(currentTicket);
let roundClosed = Date.now() >= round.closesAt;
let resolved = false;
let pulseRetries = 0;
let lastPulseError = '';
let pollTimer;
let pulseInFlight = false;

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
function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((record) => record && typeof record.roundId === 'string' && record.picks) : [];
  } catch {
    return [];
  }
}
function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    return true;
  } catch {
    return false;
  }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function pickLabel(key, value) {
  const labels = {
    parity: { odd: '홀수', even: '짝수' },
    range: { under: '언더 (3–16)', push: '정확히 17', over: '오버 (18–30)' },
    combo: { none: '모두 다름', pair: '페어', triple: '트리플' },
  };
  return labels[key]?.[value] ?? '알 수 없음';
}
function pickCategory(key) {
  return key === 'parity' ? '홀짝' : key === 'range' ? '총점 구간' : '숫자 조합';
}
function renderHistory() {
  const recent = history.slice(-8).reverse();
  if (!recent.length) {
    els.history.innerHTML = '<p class="history-empty">아직 접수한 예측이 없습니다.</p>';
    return;
  }
  els.history.innerHTML = recent.map((record) => {
    const picks = Object.entries(record.picks).filter(([, value]) => Boolean(value));
    const picksHtml = picks.map(([key, value]) => `<span class="history-pick">${escapeHtml(pickCategory(key))}: ${escapeHtml(pickLabel(key, value))}</span>`).join('');
    const state = record.status === 'resolved' ? '결과 확인' : record.roundId === roundId ? '이번 라운드 · 대기' : '결과 대기';
    const at = Date.parse(record.submittedAt);
    const submitted = Number.isFinite(at) ? timeKorea(at) : '시각 정보 없음';
    let resultHtml = '';
    if (record.outcome && record.hits) {
      const outcome = record.outcome;
      const labels = { parity: pickLabel('parity', outcome.parity), range: pickLabel('range', outcome.range), combo: pickLabel('combo', outcome.combo) };
      const hitCount = Object.values(record.hits).filter(Boolean).length;
      const entryCount = Object.keys(record.hits).length;
      resultHtml = `<div class="history-result">총점 ${escapeHtml(outcome.total)}점 · 적중 ${hitCount}/${entryCount} · 실제: ${escapeHtml(Object.values(labels).join(' / '))}</div>`;
    }
    return `<article class="history-item"><div class="history-top"><strong>${escapeHtml(record.roundId)}</strong><span class="history-state">${state}</span></div><div class="history-picks">${picksHtml}</div><small>접수 ${escapeHtml(submitted)} KST</small>${resultHtml}</article>`;
  }).join('');
}
function updateTimes() {
  els.roundId.textContent = roundId;
  els.open.textContent = timeKorea(round.openAt);
  els.close.textContent = timeKorea(round.closesAt);
  els.pulse.textContent = timeKorea(round.pulseAt);
}
function restoreTicket() {
  if (!currentTicket) return;
  for (const [key, value] of Object.entries(currentTicket.picks)) {
    const input = [...document.querySelectorAll(`input[name="${key}"]`)].find((candidate) => candidate.value === value);
    if (input) input.checked = true;
  }
  setInputsDisabled(true);
  els.lock.disabled = true;
  els.lock.textContent = '예측 접수됨';
  els.pickStatus.textContent = '이 라운드의 접수 내역을 불러왔습니다.';
  els.panel.classList.add('locked');
}
function getPicks() {
  return {
    parity: document.querySelector('input[name="parity"]:checked')?.value,
    range: document.querySelector('input[name="range"]:checked')?.value,
    combo: document.querySelector('input[name="combo"]:checked')?.value,
  };
}
function setInputsDisabled(disabled) {
  document.querySelectorAll('input[name="parity"],input[name="range"],input[name="combo"]').forEach((input) => { input.disabled = disabled; });
}
function submitPicks() {
  if (picksLocked || roundClosed || Date.now() >= round.closesAt) return;
  const picks = Object.fromEntries(Object.entries(getPicks()).filter(([, value]) => Boolean(value)));
  if (!hasAnyPick(picks)) return;
  const ticket = {
    roundId,
    openAt: round.openAt,
    closesAt: round.closesAt,
    pulseAt: round.pulseAt,
    submittedAt: new Date().toISOString(),
    picks,
    status: 'pending',
  };
  history = [...history.filter((record) => record.roundId !== roundId), ticket];
  currentTicket = ticket;
  selectedPicks = picks;
  picksLocked = true;
  const persisted = saveHistory();
  setInputsDisabled(true);
  els.lock.disabled = true;
  els.lock.textContent = '예측 접수됨';
  els.pickStatus.textContent = persisted ? '접수 완료! 아래 내역에서 확인할 수 있어요.' : '접수했지만 브라우저 저장에 실패했습니다. 이 화면에서만 확인할 수 있어요.';
  els.panel.classList.add('locked');
  renderHistory();
}
function updatePickButton() {
  if (picksLocked || roundClosed) return;
  const picks = getPicks();
  const count = Object.values(picks).filter(Boolean).length;
  els.lock.disabled = !hasAnyPick(picks);
  els.pickStatus.textContent = count ? `${count}개 유형 선택됨. 선택한 항목만 접수됩니다.` : '선택한 항목만 접수됩니다. 한 항목 이상 골라 주세요.';
}
function closeRound() {
  roundClosed = true;
  if (!picksLocked) {
    setInputsDisabled(true);
    els.lock.disabled = true;
    els.lock.textContent = '접수 마감';
    els.pickStatus.textContent = hasAnyPick(getPicks()) ? '마감됐어요. 제출하지 않은 선택은 접수되지 않았습니다.' : '마감됐어요. 접수된 예측이 없습니다.';
    els.panel.classList.add('locked');
  }
}
function tick() {
  const now = Date.now();
  if (!roundClosed && now >= round.closesAt) closeRound();
  if (now < round.closesAt) {
    const seconds = Math.ceil((round.closesAt - now) / 1000);
    els.countdown.textContent = `00:${String(seconds).padStart(2, '0')}`;
    els.clockLabel.textContent = '선택 마감까지';
  } else if (now < round.pulseAt) {
    els.countdown.textContent = `00:${String(Math.ceil((round.pulseAt - now) / 1000)).padStart(2, '0')}`;
    els.clockLabel.textContent = '펄스 생성까지';
  } else if (!resolved) {
    els.countdown.textContent = '대기';
    els.clockLabel.textContent = 'NIST 펄스 확인 중';
    if (!pollTimer && !pulseInFlight) pollForTargetPulse();
  }
}
function validatePulseResponse(body, expectedTime = null) {
  const pulse = body?.pulse;
  const timestamp = Date.parse(pulse?.timeStamp ?? '');
  if (!pulse || pulse.statusCode !== 0 || pulse.chainIndex !== CHAIN || !Number.isInteger(pulse.pulseIndex) || !Number.isFinite(timestamp) || !Number.isFinite(pulse.period) || pulse.period <= 0 || !/^[0-9a-f]+$/i.test(pulse.localRandomValue ?? '')) {
    throw new Error('비컨 응답의 필수 필드가 없거나 상태 코드가 정상(0)이 아닙니다.');
  }
  if (expectedTime !== null && timestamp !== expectedTime) {
    throw new Error(`지정 시각 펄스와 응답 시각이 다릅니다. 응답: ${pulse.timeStamp}`);
  }
  return pulse;
}
async function getJson(url) {
  const options = { cache: 'no-store', headers: { Accept: 'application/json' } };
  if (typeof AbortSignal.timeout === 'function') options.signal = AbortSignal.timeout(10_000);
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`NIST 응답 오류 (HTTP ${response.status})`);
  return response.json();
}
function showError(message, retryTarget = false) {
  els.shotStatus.textContent = '펄스 조회 오류';
  els.proof.innerHTML = `<span class="error-text">${escapeHtml(message)}</span> <button id="retry-beacon" class="button retry">다시 조회</button>`;
  $('#retry-beacon')?.addEventListener('click', () => {
    els.proof.textContent = 'NIST 비컨에 다시 연결하는 중…';
    pulseRetries = 0;
    lastPulseError = '';
    if (retryTarget) pollForTargetPulse();
    else loadBaseline();
  });
}
async function loadBaseline() {
  try {
    els.shotStatus.textContent = '공식 비컨 연결 확인 중';
    const pulse = validatePulseResponse(await getJson(`${API}/pulse/last`));
    els.proof.innerHTML = `<span class="muted">연결됨 · 최근 확인 펄스 #${pulse.pulseIndex}, ${escapeHtml(pulse.timeStamp)} UTC · 목표 시각 ${timeKorea(round.pulseAt)} KST</span>`;
    els.shotStatus.textContent = roundClosed ? '접수 마감 · 지정 펄스 대기' : '예측 접수 중';
    tick();
  } catch (error) {
    showError(`NIST 비컨에 연결하지 못했습니다: ${error.message}`);
  }
}
function schedulePulseRetry(delay = POLL_INTERVAL_MS) {
  if (resolved || pollTimer) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = undefined;
    pollForTargetPulse();
  }, delay);
}
async function pollForTargetPulse() {
  if (resolved || pulseInFlight) return;
  const delay = Math.max(0, round.pulseAt - Date.now());
  if (delay > 0) {
    schedulePulseRetry(delay);
    return;
  }
  pulseInFlight = true;
  let targetPulse;
  try {
    const latest = validatePulseResponse(await getJson(`${API}/pulse/last`));
    const latestAt = Date.parse(latest.timeStamp);
    const plan = targetPulsePlan(latest, round.pulseAt);
    if (plan.kind === 'wait') {
      pulseRetries += 1;
      els.shotStatus.textContent = `NIST 펄스 지연 · 최근 ${timeKorea(latestAt)} KST (${pulseRetries}/${MAX_PULSE_RETRIES})`;
    } else if (plan.kind === 'use-latest') {
      targetPulse = latest;
    } else {
      const body = await getJson(`${API}/chain/${CHAIN}/pulse/${plan.pulseIndex}`);
      targetPulse = validatePulseResponse(body, round.pulseAt);
      if (targetPulse.pulseIndex !== plan.pulseIndex) throw new Error('대상 펄스 번호와 계산한 번호가 다릅니다.');
    }
    if (targetPulse) {
      resolved = true;
      els.shotStatus.textContent = `펄스 #${targetPulse.pulseIndex} 확인 · 세 발 발사`;
      els.countdown.textContent = '완료';
      await revealRound(targetPulse);
    }
  } catch (error) {
    pulseRetries += 1;
    lastPulseError = error.message;
    els.shotStatus.textContent = `대상 펄스 재조회 중 (${pulseRetries}/${MAX_PULSE_RETRIES})`;
  } finally {
    pulseInFlight = false;
  }
  if (!resolved) {
    if (pulseRetries >= MAX_PULSE_RETRIES) {
      showError(`대상 시각 ${new Date(round.pulseAt).toISOString()}의 펄스를 확인하지 못했습니다. 다른 펄스로 대체하지 않았습니다. ${lastPulseError ? `마지막 오류: ${lastPulseError}` : 'NIST의 최신 펄스가 아직 목표 시각에 도달하지 않았습니다.'}`, true);
    } else {
      schedulePulseRetry();
    }
  }
}
function predictionLabels(outcome) {
  return {
    parity: outcome.parity === 'odd' ? '홀수' : '짝수',
    range: outcome.range === 'under' ? '언더' : outcome.range === 'over' ? '오버' : '정확히 17',
    combo: outcome.combo === 'pair' ? '페어' : outcome.combo === 'triple' ? '트리플' : '모두 다름',
  };
}
function renderPredictionResult(outcome) {
  if (!currentTicket || !hasAnyPick(currentTicket.picks)) {
    els.predictionResult.textContent = '접수된 예측이 없어 결과만 공개합니다.';
    return;
  }
  const hits = evaluatePicks(currentTicket.picks, outcome);
  const actual = predictionLabels(outcome);
  const checks = Object.entries(hits).map(([key, isWin]) => {
    const name = pickCategory(key);
    return `<span class="${isWin ? 'win' : 'miss'}">${name} ${isWin ? '적중' : '불일치'} (${actual[key]})</span>`;
  });
  els.predictionResult.innerHTML = checks.join('<br>');
  const updated = {
    ...currentTicket,
    status: 'resolved',
    hits,
    outcome: { total: outcome.total, parity: outcome.parity, range: outcome.range, combo: outcome.combo },
  };
  history = history.map((record) => record.roundId === roundId ? updated : record);
  currentTicket = updated;
  saveHistory();
  renderHistory();
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
  const bytes = converted.used.map((byte) => `#${byte.index} ${byte.hex} → ${byte.digit}`).join(' · ');
  const skipped = converted.skipped.length ? ` · 건너뜀 ${converted.skipped.map((byte) => `#${byte.index} ${byte.hex}`).join(', ')}` : '';
  const uri = pulse.uri || `${API}/chain/${CHAIN}/pulse/${pulse.pulseIndex}`;
  els.proof.innerHTML = `<div><a href="${escapeHtml(uri)}" target="_blank" rel="noopener noreferrer">NIST 원본 펄스 #${pulse.pulseIndex} ↗</a> · ${escapeHtml(pulse.timeStamp)} UTC · ${timeKorea(Date.parse(pulse.timeStamp))} KST</div><details><summary>난수값과 변환 바이트 보기</summary><code>${escapeHtml(pulse.localRandomValue)}</code><div>${escapeHtml(bytes + skipped)}</div></details>`;
  els.shotStatus.textContent = '세 발 결과 공개 완료';
}

restoreTicket();
if (roundClosed && !picksLocked) closeRound();
renderHistory();
document.querySelectorAll('input[name="parity"],input[name="range"],input[name="combo"]').forEach((input) => input.addEventListener('change', updatePickButton));
els.lock.addEventListener('click', submitPicks);
updateTimes();
window.setInterval(tick, 250);
loadBaseline();
