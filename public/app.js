/* ════════════════════════════════════════════════════════
   서울 지하철 혼잡도 AI — app.js
   색상: CSS var에서만 읽음 (JS 하드코딩 금지)
════════════════════════════════════════════════════════ */
'use strict';

// ── 색상: CSS 단일 소스에서 읽기 ─────────────────────────
const CSS = getComputedStyle(document.documentElement);
const CLR = {
  low:         CSS.getPropertyValue('--c-low').trim()      || 'oklch(65% 0.17 145)',
  medium:      CSS.getPropertyValue('--c-medium').trim()   || 'oklch(75% 0.18 90)',
  high:        CSS.getPropertyValue('--c-high').trim()     || 'oklch(65% 0.25 35)',
  critical:    CSS.getPropertyValue('--c-critical').trim() || 'oklch(55% 0.28 20)',
  lowDim:      CSS.getPropertyValue('--c-low-dim').trim()      || 'oklch(65% 0.17 145 / 0.15)',
  mediumDim:   CSS.getPropertyValue('--c-medium-dim').trim()   || 'oklch(75% 0.18 90 / 0.15)',
  highDim:     CSS.getPropertyValue('--c-high-dim').trim()     || 'oklch(65% 0.25 35 / 0.15)',
  criticalDim: CSS.getPropertyValue('--c-critical-dim').trim() || 'oklch(55% 0.28 20 / 0.15)',
  text:        CSS.getPropertyValue('--text-lo').trim()    || '#888',
  border:      CSS.getPropertyValue('--border').trim()     || '#333',
};

function levelColor(level, dim = false) {
  if (dim) return CLR[level + 'Dim'] || CLR.lowDim;
  return CLR[level] || CLR.low;
}

function pctToLevel(v) {
  if (v < 30) return 'low';
  if (v < 60) return 'medium';
  if (v < 90) return 'high';
  return 'critical';
}

function levelLabel(level) {
  return { low: '매우 쾌적', medium: '보통', high: '혼잡', critical: '매우 혼잡' }[level] || level;
}

// ── API 헬퍼 ─────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API 오류: ${res.status}`);
  return res.json();
}

// ── 토스트 ────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ── 자동완성 헬퍼 ────────────────────────────────────────
function setupAutocomplete(input, dropdown, getList, onSelect) {
  let highlighted = -1;

  input.addEventListener('input', () => {
    const q = input.value.trim();
    const list = getList();
    if (!q || !list.length) { dropdown.hidden = true; return; }
    const filtered = list.filter(s => s.includes(q)).slice(0, 12);
    if (!filtered.length) { dropdown.hidden = true; return; }
    dropdown.innerHTML = filtered.map((s, i) =>
      `<li data-idx="${i}" data-val="${s}">${s}</li>`
    ).join('');
    dropdown.hidden = false;
    highlighted = -1;
  });

  input.addEventListener('keydown', e => {
    const items = dropdown.querySelectorAll('li');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, items.length - 1);
      items.forEach((li, i) => li.classList.toggle('active', i === highlighted));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, 0);
      items.forEach((li, i) => li.classList.toggle('active', i === highlighted));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const active = dropdown.querySelector('li.active') || dropdown.querySelector('li');
      if (active) { pick(active.dataset.val); }
    } else if (e.key === 'Escape') {
      dropdown.hidden = true;
    }
  });

  dropdown.addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (li) { e.preventDefault(); pick(li.dataset.val); }
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.hidden = true;
  });

  function pick(val) {
    input.value = val;
    dropdown.hidden = true;
    highlighted = -1;
    onSelect(val);
  }
}

// ════════════════════════════════════════════════════════
//  뷰 탭 전환
// ════════════════════════════════════════════════════════
document.querySelectorAll('.view-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    const id = 'view-' + btn.dataset.target;
    const view = document.getElementById(id);
    if (view) view.classList.add('active');
    document.body.dataset.view = btn.dataset.target;
  });
});

// ════════════════════════════════════════════════════════
//  전역 상태
// ════════════════════════════════════════════════════════
const STATE = {
  lines:      [],       // ['1호선', '2호선', …]
  allStations: [],      // [{name, line}]
  // 예측 뷰
  line:        '',
  station:     '',
  day:         '평일',
  direction:   '',
  allDirs:     [],
  // 히트맵 뷰
  hmLine:      '',
  hmDay:       '평일',
  // 비교 뷰
  cmpStations: [],      // [{name, line}]
  cmpDay:      '평일',
  // 실시간 뷰
  rtLine:      '',
  rtStation:   '',
  rtTimer:     null,
};

// ── Chart.js 인스턴스 레지스트리 ─────────────────────────
const CHARTS = {};

function destroyChart(key) {
  if (CHARTS[key]) { CHARTS[key].destroy(); CHARTS[key] = null; }
}

// ════════════════════════════════════════════════════════
//  1. 초기화: 노선 목록 + 통계
// ════════════════════════════════════════════════════════
async function init() {
  try {
    const lines = await api('/api/lines');
    STATE.lines = lines;

    // 노선 선택 셀렉트 모두 채우기
    ['lineSelect', 'heatmapLineSelect', 'rtLineSelect'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.innerHTML = '<option value="">노선 선택…</option>' +
        lines.map(l => `<option value="${l}">${l}</option>`).join('');
    });

    // ── 콜드 스타트 오버레이 해제 (lines 첫 응답 완료) ────
    if (typeof window.__hideColdOverlay === 'function') window.__hideColdOverlay();

    // 비교 뷰: 전체 역 목록 미리 로드
    const stationsAll = await api('/api/stations');
    STATE.allStations = stationsAll.map(s => ({ name: s.name, line: s.line }));

    // 통계
    try {
      const stats = await api('/api/stats');
      document.getElementById('statStations').textContent =
        `🏢 ${stats.stationCount}개 역`;
      document.getElementById('statRecords').textContent =
        `📊 ${(stats.recordCount || 0).toLocaleString()}건`;
    } catch (_) {}

  } catch (e) {
    showToast('서버에 연결할 수 없습니다. 잠시 후 새로고침하세요.');
    console.error(e);
  }
}

// ════════════════════════════════════════════════════════
//  2. 예측 뷰 — 노선·역·요일·방향 선택
// ════════════════════════════════════════════════════════
const lineSelect    = document.getElementById('lineSelect');
const stationInput  = document.getElementById('stationInput');
const stationDrop   = document.getElementById('stationDropdown');
const dirWrap       = document.getElementById('directionWrap');
const dirBtns       = document.getElementById('directionBtns');
const emptyState    = document.getElementById('emptyState');
const resultPanel   = document.getElementById('resultPanel');

let stationList = []; // 현재 노선의 역 이름 목록

lineSelect.addEventListener('change', async () => {
  const line = lineSelect.value;
  STATE.line = line;
  STATE.station = '';
  STATE.direction = '';
  stationInput.value = '';
  stationDrop.hidden = true;

  if (!line) {
    stationInput.disabled = true;
    showResult(false);
    return;
  }

  stationInput.disabled = false;
  stationInput.placeholder = '역 이름 검색…';

  try {
    stationList = await api(`/api/line-stations?line=${encodeURIComponent(line)}`);
  } catch (_) { stationList = []; }
});

setupAutocomplete(
  stationInput, stationDrop,
  () => stationList,
  val => { STATE.station = val; fetchPredict(); }
);

// 요일 탭 (예측 뷰)
document.querySelectorAll('#view-predict .day-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#view-predict .day-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    STATE.day = btn.dataset.day;
    if (STATE.station) fetchPredict();
  });
});

// 방향 버튼
function renderDirectionBtns(dirs, currentDir) {
  if (!dirs || dirs.length <= 1) {
    dirWrap.hidden = true;
    STATE.direction = dirs[0] || '';
    return;
  }
  dirWrap.hidden = false;
  dirBtns.innerHTML = dirs.map(d =>
    `<button class="dir-btn ${d === currentDir ? 'active' : ''}" data-dir="${d}">${d}</button>`
  ).join('');
  dirBtns.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      dirBtns.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      STATE.direction = btn.dataset.dir;
      fetchPredict(true); // direction만 변경 — 차트만 업데이트
    });
  });
}

function showResult(show) {
  emptyState.hidden = show;
  resultPanel.hidden = !show;
}

// ── 예측 데이터 fetch ─────────────────────────────────
async function fetchPredict(dirOnly = false) {
  if (!STATE.line || !STATE.station) return;

  try {
    const params = new URLSearchParams({
      line: STATE.line,
      station: STATE.station,
      day: STATE.day,
    });
    if (STATE.direction) params.set('direction', STATE.direction);

    const data = await api(`/api/predict?${params}`);

    if (!dirOnly) {
      STATE.allDirs = data.allDirections || [];
      // direction 초기화 (첫 번째 방향)
      if (!STATE.direction || !STATE.allDirs.includes(STATE.direction)) {
        STATE.direction = STATE.allDirs[0] || '';
      }
      renderDirectionBtns(STATE.allDirs, STATE.direction);
    }

    showResult(true);

    // 차트 (독립 try — 실패해도 다른 패널 유지)
    try {
      renderTimelineChart(data.directions, STATE.direction);
      renderChartDirToggle(STATE.allDirs, STATE.direction, data.directions);
    } catch (chartErr) { console.warn('차트 렌더 오류:', chartErr); }

    // 인사이트 (dirOnly여도 업데이트)
    if (data.insight) {
      try { renderInsight(data.insight); } catch (_) {}
    }

    // 추천
    fetchRecommend();

    // 실시간 (예측 뷰 내부 미니)
    fetchRealtimeMini();

  } catch (e) {
    showToast(`데이터 없음: ${STATE.station} (${STATE.day})`);
    showResult(false);
    console.error(e);
  }
}

// ── 차트 방향 토글 ────────────────────────────────────
function renderChartDirToggle(dirs, currentDir, directions) {
  const wrap = document.getElementById('chartDirToggle');
  if (!dirs || dirs.length <= 1) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = dirs.map(d =>
    `<button class="dir-btn ${d === currentDir ? 'active' : ''}" style="padding:4px 10px;font-size:.78rem" data-dir="${d}">${d}</button>`
  ).join('');
  wrap.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // 같은 directions 배열 내에서 방향만 필터
      const picked = directions.find(d => d.direction === btn.dataset.dir);
      if (picked) updateTimelineChart([picked]);
    });
  });
}

// ── AI 추천 fetch ─────────────────────────────────────
async function fetchRecommend() {
  try {
    const data = await api(
      `/api/recommend?line=${encodeURIComponent(STATE.line)}&station=${encodeURIComponent(STATE.station)}&day=${encodeURIComponent(STATE.day)}`
    );
    renderRecommend(data);
  } catch (_) {}
}

// ── 실시간 미니 fetch ─────────────────────────────────
async function fetchRealtimeMini() {
  try {
    const data = await api(
      `/api/realtime?line=${encodeURIComponent(STATE.line)}&station=${encodeURIComponent(STATE.station)}`
    );
    renderRealtimeMini(data);
  } catch (_) {}
}

// ════════════════════════════════════════════════════════
//  타임라인 차트 렌더링
// ════════════════════════════════════════════════════════
function renderTimelineChart(directions, currentDir) {
  const target = directions.find(d => d.direction === currentDir) || directions[0];
  if (!target) return;
  updateTimelineChart([target]);
}

function updateTimelineChart(dirList) {
  destroyChart('timeline');
  const canvas = document.getElementById('timelineChart');
  if (!canvas) return;

  // 첫 번째 방향의 데이터를 기본으로 사용 (추후 다중 가능)
  const dir = dirList[0];
  if (!dir) return;

  const labels = dir.slots.map(s => s.label);
  const values = dir.slots.map(s => s.congestion);
  const bgColors = values.map(v => levelColor(pctToLevel(v)));
  const borderColors = bgColors.map(c => c); // 동일

  // 현재 시각 마커
  const now = new Date();
  const nowH = now.getHours() + now.getMinutes() / 60;
  let nowIdx = -1, bestDiff = Infinity;
  dir.slots.forEach((s, i) => {
    const diff = Math.abs(s.hour - nowH);
    if (diff < bestDiff) { bestDiff = diff; nowIdx = i; }
  });

  CHARTS.timeline = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: `${dir.direction} 혼잡도 (%)`,
        data: values,
        backgroundColor: bgColors,
        borderColor: borderColors,
        borderWidth: 0,
        borderRadius: 3,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              const lv = pctToLevel(v);
              return ` ${v}%  ${levelLabel(lv)}`;
            }
          },
          backgroundColor: 'oklch(15% 0.02 250)',
          titleColor: '#fff',
          bodyColor: '#aaa',
          borderColor: 'oklch(30% 0.03 250)',
          borderWidth: 1,
        },
        annotation: nowIdx >= 0 ? {
          annotations: {
            nowLine: {
              type: 'line',
              xMin: nowIdx,
              xMax: nowIdx,
              borderColor: 'oklch(75% 0.18 90)',
              borderWidth: 2,
              borderDash: [4, 4],
              label: {
                display: true,
                content: '지금',
                backgroundColor: 'oklch(75% 0.18 90)',
                color: '#000',
                font: { size: 10, weight: 'bold' },
                position: 'end',
              }
            }
          }
        } : {}
      },
      scales: {
        x: {
          grid: { color: CLR.border, lineWidth: 0.5 },
          ticks: {
            color: CLR.text,
            font: { size: 10, family: "'Pretendard', sans-serif" },
            maxRotation: 45,
            callback(val, i) {
              // 1시간 단위만 표시
              const label = this.getLabelForValue(val);
              return label && label.endsWith(':00') ? label : '';
            }
          },
        },
        y: {
          min: 0,
          max: 150,
          grid: { color: CLR.border, lineWidth: 0.5 },
          ticks: {
            color: CLR.text,
            font: { size: 10, family: "'Pretendard', sans-serif" },
            callback: v => v + '%',
            stepSize: 30,
          },
        }
      }
    }
  });
}

// ════════════════════════════════════════════════════════
//  AI 인사이트 렌더링
// ════════════════════════════════════════════════════════
function renderInsight(insight) {
  document.getElementById('insightGrade').textContent = insight.grade || '–';

  const list = document.getElementById('insightComments');
  list.innerHTML = (insight.comments || []).map(c =>
    `<li>${c}</li>`
  ).join('');

  const peaks = document.getElementById('peakPeriods');
  peaks.innerHTML = (insight.peakPeriods || []).map(p =>
    `<span class="peak-chip">⚡ ${p.start}–${p.end} (최대 ${p.max}%)</span>`
  ).join('');
}

// ════════════════════════════════════════════════════════
//  추천 카드 렌더링
// ════════════════════════════════════════════════════════
function renderRecommend(data) {
  const { top3, grade } = data;
  document.getElementById('recGrade').textContent = grade || '–';

  const list = document.getElementById('top3List');
  list.innerHTML = (top3 || []).map((t, i) => {
    const lv = t.level || pctToLevel(t.congestion);
    return `
    <div class="top3-item" data-level="${lv}">
      <div class="top3-rank" style="background:${levelColor(lv)}">${i + 1}</div>
      <div>
        <div class="top3-time">${t.time}</div>
        <div class="top3-label">${t.label}</div>
      </div>
      <div class="top3-pct" style="color:${levelColor(lv)}">${t.congestion}%</div>
    </div>`;
  }).join('');

  // 지금 vs 30분 후 비교 (실시간 데이터로 채움)
  updateNowVs30();
}

async function updateNowVs30() {
  if (!STATE.line || !STATE.station) return;
  try {
    const rt = await api(
      `/api/realtime?line=${encodeURIComponent(STATE.line)}&station=${encodeURIComponent(STATE.station)}`
    );
    const nowVs = document.getElementById('nowVs30');
    const vsNow = document.getElementById('vsNow');
    const vs30  = document.getElementById('vs30min');
    nowVs.hidden = false;

    const lvNow = rt.currentLevel || pctToLevel(rt.currentCongestion);
    const lvNxt = rt.nextLevel || pctToLevel(rt.nextCongestion);

    vsNow.innerHTML = `
      <div class="vs-time">${rt.currentTime}</div>
      <div class="vs-pct" style="color:${levelColor(lvNow)}">${rt.currentCongestion}%</div>
      <div class="vs-lv" style="color:${levelColor(lvNow)}">${rt.currentLabel}</div>`;

    vs30.innerHTML = `
      <div class="vs-time">${rt.nextTime}</div>
      <div class="vs-pct" style="color:${levelColor(lvNxt)}">${rt.nextCongestion}%</div>
      <div class="vs-lv" style="color:${levelColor(lvNxt)}">${rt.nextLevel ? levelLabel(rt.nextLevel) : ''}</div>`;
  } catch (_) {
    document.getElementById('nowVs30').hidden = true;
  }
}

// ════════════════════════════════════════════════════════
//  실시간 미니 패널 렌더링 (예측 뷰 내)
// ════════════════════════════════════════════════════════
function renderRealtimeMini(data) {
  const lvNow = data.currentLevel || pctToLevel(data.currentCongestion);
  const lvNxt = data.nextLevel || pctToLevel(data.nextCongestion);

  const nowBar = document.getElementById('rtNowBar');
  const nxtBar = document.getElementById('rtNextBar');

  document.getElementById('rtNowTime').textContent  = data.currentTime;
  document.getElementById('rtNowPct').textContent   = data.currentCongestion + '%';
  document.getElementById('rtNowLabel').textContent = data.currentLabel;
  document.getElementById('rtNowLabel').dataset.level = lvNow;
  nowBar.style.width     = Math.min(data.currentCongestion, 100) + '%';
  nowBar.dataset.level   = lvNow;
  nowBar.style.background = levelColor(lvNow);

  document.getElementById('rtNextTime').textContent  = data.nextTime;
  document.getElementById('rtNextPct').textContent   = data.nextCongestion + '%';
  document.getElementById('rtNextLabel').textContent = levelLabel(lvNxt);
  document.getElementById('rtNextLabel').dataset.level = lvNxt;
  nxtBar.style.width     = Math.min(data.nextCongestion, 100) + '%';
  nxtBar.dataset.level   = lvNxt;
  nxtBar.style.background = levelColor(lvNxt);

  const arrow = document.getElementById('rtTrendArrow');
  const trendMap = { increasing: '↑', decreasing: '↓', stable: '→' };
  arrow.textContent = trendMap[data.trend] || '→';
  arrow.dataset.trend = data.trend;
}

// ════════════════════════════════════════════════════════
//  3. 히트맵 뷰
// ════════════════════════════════════════════════════════
const hmLineSelect = document.getElementById('heatmapLineSelect');

hmLineSelect.addEventListener('change', () => {
  STATE.hmLine = hmLineSelect.value;
  if (STATE.hmLine) fetchHeatmap();
});

document.querySelectorAll('#view-heatmap .day-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#view-heatmap .day-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    STATE.hmDay = btn.dataset.day;
    if (STATE.hmLine) fetchHeatmap();
  });
});

async function fetchHeatmap() {
  const empty = document.getElementById('heatmapEmpty');
  const panel = document.getElementById('heatmapPanel');
  empty.hidden = true;
  panel.hidden = true;

  try {
    const data = await api(
      `/api/heatmap?line=${encodeURIComponent(STATE.hmLine)}&day=${encodeURIComponent(STATE.hmDay)}`
    );
    document.getElementById('heatmapTitle').textContent =
      `${STATE.hmLine} 혼잡도 히트맵 (${STATE.hmDay})`;
    renderHeatmap(data);
    panel.hidden = false;
  } catch (e) {
    showToast('히트맵 데이터를 불러올 수 없습니다.');
    empty.hidden = false;
    console.error(e);
  }
}

function renderHeatmap(data) {
  const table = document.getElementById('heatmapTable');
  const { stations, timeSlots } = data;
  if (!stations || !stations.length) { table.innerHTML = ''; return; }

  // 1시간 단위 슬롯만 사용 (너비 절감)
  const hourSlots = timeSlots.filter(t => t.label.endsWith(':00'));

  // 헤더
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>
    <th>역</th>
    ${hourSlots.map(t => `<th>${t.label}</th>`).join('')}
  </tr>`;

  // 바디
  const tbody = document.createElement('tbody');
  stations.forEach(st => {
    const tr = document.createElement('tr');
    const stationSlotMap = {};
    (st.slots || []).forEach(s => { stationSlotMap[s.label] = s; });

    tr.innerHTML = `<td class="hm-station">${st.station}</td>` +
      hourSlots.map(t => {
        const s = stationSlotMap[t.label];
        if (!s) return `<td style="background:var(--bg-2)"><div class="hm-cell">–</div></td>`;
        const lv = s.level || pctToLevel(s.congestion);
        const bg = levelColor(lv);
        const txt = Math.round(s.congestion);
        return `<td data-level="${lv}" title="${t.label} ${txt}% (${levelLabel(lv)})">
          <div class="hm-cell" style="background:${bg};color:${lv==='medium'?'#111':'#eee'}">${txt}</div>
        </td>`;
      }).join('');
    tbody.appendChild(tr);
  });

  table.innerHTML = '';
  table.appendChild(thead);
  table.appendChild(tbody);
}

// ════════════════════════════════════════════════════════
//  4. 역 비교 뷰
// ════════════════════════════════════════════════════════
const compareInput  = document.getElementById('compareInput');
const compareDrop   = document.getElementById('compareDropdown');
const compareAddBtn = document.getElementById('compareAddBtn');
const compareChips  = document.getElementById('compareChips');

setupAutocomplete(
  compareInput, compareDrop,
  () => STATE.allStations.map(s => s.name),
  val => { compareInput.value = val; }
);

compareAddBtn.addEventListener('click', () => {
  const name = compareInput.value.trim();
  if (!name) return;
  addCompareStation(name);
});

compareInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const name = compareInput.value.trim();
    if (name) addCompareStation(name);
  }
});

function addCompareStation(name) {
  if (STATE.cmpStations.length >= 4) {
    showToast('최대 4개 역까지 비교 가능합니다.');
    return;
  }
  if (STATE.cmpStations.find(s => s.name === name)) {
    showToast('이미 추가된 역입니다.');
    return;
  }
  const found = STATE.allStations.find(s => s.name === name);
  if (!found) { showToast('역을 찾을 수 없습니다.'); return; }
  STATE.cmpStations.push({ name, line: found.line });
  compareInput.value = '';
  renderCompareChips();
  if (STATE.cmpStations.length >= 2) fetchCompare();
}

function removeCompareStation(name) {
  STATE.cmpStations = STATE.cmpStations.filter(s => s.name !== name);
  renderCompareChips();
  if (STATE.cmpStations.length >= 2) fetchCompare();
  else {
    document.getElementById('compareEmpty').hidden = false;
    document.getElementById('comparePanel').hidden = true;
    destroyChart('compare');
  }
}

function renderCompareChips() {
  compareChips.innerHTML = STATE.cmpStations.map(s =>
    `<div class="compare-chip">
      <span class="chip-line">${s.line}</span>
      <span>${s.name}</span>
      <button class="chip-remove" data-name="${s.name}">✕</button>
    </div>`
  ).join('');
  compareChips.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', () => removeCompareStation(btn.dataset.name));
  });
}

document.querySelectorAll('#view-compare .day-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#view-compare .day-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    STATE.cmpDay = btn.dataset.day;
    if (STATE.cmpStations.length >= 2) fetchCompare();
  });
});

async function fetchCompare() {
  try {
    const names = STATE.cmpStations.map(s => s.name).join(',');
    const data = await api(
      `/api/compare?stations=${encodeURIComponent(names)}&day=${encodeURIComponent(STATE.cmpDay)}`
    );
    document.getElementById('compareEmpty').hidden = true;
    document.getElementById('comparePanel').hidden = false;
    renderCompareChart(data.result);
  } catch (e) {
    showToast('비교 데이터를 불러올 수 없습니다.');
    console.error(e);
  }
}

// 고정 색상 팔레트 (비교 뷰 — 역별 구분용)
const COMPARE_PALETTE = [
  'oklch(62% 0.22 260)',
  'oklch(65% 0.17 145)',
  'oklch(75% 0.18 90)',
  'oklch(65% 0.25 35)',
];

function renderCompareChart(result) {
  destroyChart('compare');
  const canvas = document.getElementById('compareChart');
  if (!canvas) return;

  const valid = result.filter(r => r.found && r.slots);
  if (!valid.length) { showToast('비교 가능한 데이터가 없습니다.'); return; }

  const labels = valid[0].slots.map(s => s.label);
  const datasets = valid.map((r, i) => ({
    label: r.station,
    data: r.slots.map(s => s.congestion),
    borderColor: COMPARE_PALETTE[i % COMPARE_PALETTE.length],
    backgroundColor: COMPARE_PALETTE[i % COMPARE_PALETTE.length].replace(')', ' / 0.15)'),
    borderWidth: 2,
    pointRadius: 2,
    pointHoverRadius: 5,
    tension: 0.35,
    fill: false,
  }));

  CHARTS.compare = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            color: CLR.text,
            font: { family: "'Pretendard', sans-serif", size: 12 },
            usePointStyle: true,
            pointStyleWidth: 10,
          }
        },
        tooltip: {
          backgroundColor: 'oklch(15% 0.02 250)',
          titleColor: '#fff',
          bodyColor: '#aaa',
          borderColor: 'oklch(30% 0.03 250)',
          borderWidth: 1,
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}%`
          }
        }
      },
      scales: {
        x: {
          grid: { color: CLR.border, lineWidth: 0.5 },
          ticks: {
            color: CLR.text,
            font: { size: 10, family: "'Pretendard', sans-serif" },
            maxRotation: 45,
            callback(val, i) {
              const label = this.getLabelForValue(val);
              return label && label.endsWith(':00') ? label : '';
            }
          }
        },
        y: {
          min: 0,
          max: 150,
          grid: { color: CLR.border, lineWidth: 0.5 },
          ticks: {
            color: CLR.text,
            font: { size: 10, family: "'Pretendard', sans-serif" },
            callback: v => v + '%',
            stepSize: 30,
          }
        }
      }
    }
  });
}

// ════════════════════════════════════════════════════════
//  5. 실시간 뷰 (독립 페이지)
// ════════════════════════════════════════════════════════
const rtLineSelect    = document.getElementById('rtLineSelect');
const rtStationInput  = document.getElementById('rtStationInput');
const rtStationDrop   = document.getElementById('rtStationDropdown');

let rtStationList = [];

rtLineSelect.addEventListener('change', async () => {
  const line = rtLineSelect.value;
  STATE.rtLine = line;
  STATE.rtStation = '';
  rtStationInput.value = '';
  rtStationDrop.hidden = true;
  if (!line) { rtStationInput.disabled = true; return; }
  rtStationInput.disabled = false;
  try {
    rtStationList = await api(`/api/line-stations?line=${encodeURIComponent(line)}`);
  } catch (_) { rtStationList = []; }
});

setupAutocomplete(
  rtStationInput, rtStationDrop,
  () => rtStationList,
  val => { STATE.rtStation = val; startRealtime(); }
);

function startRealtime() {
  clearInterval(STATE.rtTimer);
  fetchRealtimeFull();
  STATE.rtTimer = setInterval(fetchRealtimeFull, 60000);
}

async function fetchRealtimeFull() {
  if (!STATE.rtLine || !STATE.rtStation) return;
  try {
    const data = await api(
      `/api/realtime?line=${encodeURIComponent(STATE.rtLine)}&station=${encodeURIComponent(STATE.rtStation)}`
    );
    renderRealtimeFull(data);
    document.getElementById('rtEmpty').hidden = true;
    document.getElementById('rtFullPanel').hidden = false;
  } catch (e) {
    showToast(`실시간 데이터를 불러올 수 없습니다: ${STATE.rtStation}`);
    console.error(e);
  }
}

function renderRealtimeFull(data) {
  const lvNow = data.currentLevel || pctToLevel(data.currentCongestion);
  const lvNxt = data.nextLevel || pctToLevel(data.nextCongestion);
  const colorNow = levelColor(lvNow);
  const colorNxt = levelColor(lvNxt);

  document.getElementById('rtFullTitle').textContent =
    `${STATE.rtStation} (${STATE.rtLine}) 실시간 혼잡도`;

  document.getElementById('rtFullPct').textContent   = data.currentCongestion + '%';
  document.getElementById('rtFullPct').style.color   = colorNow;
  document.getElementById('rtFullLevel').textContent = data.currentLabel;
  document.getElementById('rtFullLevel').style.color = colorNow;
  document.getElementById('rtFullTime').textContent  = data.currentTime + ' 기준';

  const bar = document.getElementById('rtFullBar');
  bar.style.width      = Math.min(data.currentCongestion, 100) + '%';
  bar.style.background = colorNow;

  document.getElementById('rtDayInfo').textContent = `요일 기준: ${data.day}`;

  // 추세 아이콘
  const arrow = document.getElementById('rtFullArrow');
  const iconMap = { increasing: '↑', decreasing: '↓', stable: '→' };
  const tipMap  = {
    increasing: '혼잡도가 오르고 있습니다. 가능하면 조금 기다렸다 탑승하는 것이 좋습니다.',
    decreasing: '혼잡도가 낮아지고 있습니다. 지금 출발하면 점점 쾌적해질 예정입니다.',
    stable:     '혼잡도가 안정적입니다. 지금 탑승해도 비슷한 상태가 유지됩니다.',
  };
  arrow.textContent    = iconMap[data.trend] || '→';
  arrow.dataset.trend  = data.trend;

  document.getElementById('rtNextTimeLabel').textContent  = data.nextTime + ' 예상';
  document.getElementById('rtNextPctFull').textContent    = data.nextCongestion + '%';
  document.getElementById('rtNextPctFull').style.color    = colorNxt;
  document.getElementById('rtNextLevelFull').textContent  = levelLabel(lvNxt);
  document.getElementById('rtNextLevelFull').style.color  = colorNxt;

  document.getElementById('rtTip').textContent = tipMap[data.trend] || '';
}

// ════════════════════════════════════════════════════════
//  뷰 전환 시 실시간 타이머 정리
// ════════════════════════════════════════════════════════
document.querySelectorAll('.view-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.target !== 'realtime') {
      clearInterval(STATE.rtTimer);
      STATE.rtTimer = null;
    } else if (STATE.rtStation) {
      startRealtime();
    }
  });
});

// ════════════════════════════════════════════════════════
//  기동
// ════════════════════════════════════════════════════════
init();
