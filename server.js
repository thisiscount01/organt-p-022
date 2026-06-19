'use strict';
// ═══════════════════════════════════════════════════════════════
//  서울 지하철 혼잡도 AI 예측 서비스  — P-022
//  데이터: 서울교통공사_지하철혼잡도정보 (OA-12928) 실제 공공데이터
// ═══════════════════════════════════════════════════════════════
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const { parse } = require('csv-parse/sync');
const cors      = require('cors');

const app  = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false, lastModified: false,
  setHeaders(res) { res.set('Cache-Control', 'no-store'); }
}));

// ── 시간 슬롯 정의 ───────────────────────────────────────────────
const TIME_SLOTS = [
  '5시30분','6시00분','6시30분','7시00분','7시30분','8시00분','8시30분',
  '9시00분','9시30분','10시00분','10시30분','11시00분','11시30분','12시00분',
  '12시30분','13시00분','13시30분','14시00분','14시30분','15시00분','15시30분',
  '16시00분','16시30분','17시00분','17시30분','18시00분','18시30분','19시00분',
  '19시30분','20시00분','20시30분','21시00분','21시30분','22시00분','22시30분',
  '23시00분','23시30분','00시00분','00시30분'
];

// 시간 슬롯 → 소수 시각 (05:30 = 5.5)
function slotToHour(slot) {
  const m = slot.match(/(\d+)시(\d+)분/);
  if (!m) return null;
  return parseInt(m[1]) + parseInt(m[2]) / 60;
}
const SLOT_HOURS = TIME_SLOTS.map(slotToHour);

// 슬롯 라벨 (UI 표시용)
function slotLabel(slot) {
  const m = slot.match(/(\d+)시(\d+)분/);
  if (!m) return slot;
  const h = parseInt(m[1]).toString().padStart(2, '0');
  const min = m[2];
  return `${h}:${min}`;
}

// ── 데이터베이스 ─────────────────────────────────────────────────
let DB        = [];       // raw rows
let LOOKUP    = {};       // `${line}|${station}|${day}|${dir}` → row
let STATIONS  = [];       // [{line, stationId, name, directions}]
let LINE_STATIONS = {};   // line → station names (id 순)

// ── AI 분석 캐시 ─────────────────────────────────────────────────
let INSIGHT_CACHE = {};   // `${line}|${station}|${day}` → insight

function congestionLevel(v) {
  if (v < 30) return 'low';
  if (v < 60) return 'medium';
  if (v < 90) return 'high';
  return 'critical';
}

function congestionLabel(v) {
  if (v < 30) return '매우 쾌적';
  if (v < 60) return '보통';
  if (v < 90) return '혼잡';
  return '매우 혼잡';
}

// AI 패턴 분석
function analyzePattern(line, station, day) {
  const rows = DB.filter(r => r.line === line && r.station === station && r.day === day);
  if (!rows.length) return null;

  // 전체 방향 평균
  const avg = TIME_SLOTS.map((_, i) => {
    const vals = rows.map(r => r.slots[i]).filter(v => v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  });

  const validAvg = avg.filter(v => v > 0);
  const avgOverall = validAvg.length
    ? Math.round(validAvg.reduce((a, b) => a + b, 0) / validAvg.length * 10) / 10
    : 0;

  // 피크 구간 탐지 (>=80%)
  const peakPeriods = [];
  let inPeak = false, peakStart = null;
  avg.forEach((v, i) => {
    if (v >= 80 && !inPeak) { inPeak = true; peakStart = i; }
    else if ((v < 80 || i === avg.length - 1) && inPeak) {
      const end = i < avg.length - 1 ? i - 1 : i;
      peakPeriods.push({
        start: slotLabel(TIME_SLOTS[peakStart]),
        end:   slotLabel(TIME_SLOTS[end]),
        max:   Math.round(Math.max(...avg.slice(peakStart, end + 1)))
      });
      inPeak = false;
    }
  });

  // 추천 TOP3 (낮은 혼잡, 06:00~22:30 사이만)
  const daytime = avg.map((v, i) => ({ slot: TIME_SLOTS[i], label: slotLabel(TIME_SLOTS[i]), hour: SLOT_HOURS[i], v }))
    .filter(s => s.hour >= 6 && s.hour <= 22.5 && s.v > 0);
  const top3 = [...daytime].sort((a, b) => a.v - b.v).slice(0, 3).map(t => ({
    time:  t.label,
    slot:  t.slot,
    congestion: Math.round(t.v * 10) / 10,
    level: congestionLevel(t.v),
    label: congestionLabel(t.v)
  }));

  // 전체 등급
  const grade = congestionLabel(avgOverall);

  // AI 코멘트 자동 생성
  const comments = [];
  const dayLabel = day;
  if (peakPeriods.length > 0) {
    const p = peakPeriods[0];
    comments.push(`${dayLabel} 기준 ${p.start}~${p.end} 구간이 가장 혼잡합니다 (최대 ${p.max}%)`);
  }
  if (peakPeriods.length >= 2) {
    const p2 = peakPeriods[1];
    comments.push(`오후 피크: ${p2.start}~${p2.end} (최대 ${p2.max}%)`);
  }
  if (top3.length > 0) {
    comments.push(`${top3[0].time} 출발이 가장 쾌적합니다 (${top3[0].congestion}%)`);
  }
  if (avgOverall > 70) {
    comments.push('전반적으로 혼잡한 역입니다 — 출발 시간 조절을 권장합니다');
  } else if (avgOverall < 40) {
    comments.push('비교적 여유로운 역입니다');
  }

  return { avg, avgOverall, grade, peakPeriods, top3, comments };
}

// ── 데이터 로딩 & 모델 초기화 ────────────────────────────────────
function loadData() {
  const csvPath = path.join(__dirname, 'data', 'congestion.csv');
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true });

  console.log(`[AI] CSV 로드: ${records.length}건`);

  const stationMap = {};

  records.forEach(row => {
    const day       = (row['요일구분'] || '').trim();
    const line      = (row['호선'] || '').trim();
    const stationId = (row['역번호'] || '').trim();
    const station   = (row['출발역'] || '').trim();
    const dir       = (row['상하구분'] || '').trim();

    if (!day || !line || !station) return;

    const slots = TIME_SLOTS.map(t => {
      const v = parseFloat(row[t]);
      return isNaN(v) ? 0 : Math.max(0, Math.min(200, v));
    });

    const key = `${line}|${station}|${day}|${dir}`;
    LOOKUP[key] = { line, station, stationId, day, dir, slots };
    DB.push({ line, station, stationId, day, dir, slots });

    const sk = `${line}|${station}`;
    if (!stationMap[sk]) stationMap[sk] = { line, stationId, name: station, directions: new Set() };
    stationMap[sk].directions.add(dir);

    if (!LINE_STATIONS[line]) LINE_STATIONS[line] = new Map();
    if (!LINE_STATIONS[line].has(station)) LINE_STATIONS[line].set(station, parseInt(stationId) || 9999);
  });

  STATIONS = Object.values(stationMap).map(s => ({
    line: s.line, stationId: s.stationId, name: s.name,
    directions: [...s.directions].sort()
  })).sort((a, b) => a.line.localeCompare(b.line) || parseInt(a.stationId) - parseInt(b.stationId));

  for (const line of Object.keys(LINE_STATIONS)) {
    LINE_STATIONS[line] = [...LINE_STATIONS[line].entries()]
      .sort((a, b) => a[1] - b[1]).map(e => e[0]);
  }

  // AI 인사이트 사전 연산
  const combos = new Set(DB.map(r => `${r.line}|${r.station}|${r.day}`));
  combos.forEach(k => {
    const [line, station, day] = k.split('|');
    INSIGHT_CACHE[k] = analyzePattern(line, station, day);
  });

  console.log(`[AI] 역 수: ${STATIONS.length}, 노선: ${Object.keys(LINE_STATIONS).sort().join('/')}`);
  console.log(`[AI] 인사이트 캐시: ${Object.keys(INSIGHT_CACHE).length}건 — 서비스 준비 완료`);
}

// ─────────────────────────────────────────────────────────────────
//  API 라우트
// ─────────────────────────────────────────────────────────────────

// 1. 노선 목록
app.get('/api/lines', (req, res) => {
  res.json(Object.keys(LINE_STATIONS).sort());
});

// 2. 역 목록
app.get('/api/stations', (req, res) => {
  const { line } = req.query;
  const result = line ? STATIONS.filter(s => s.line === line) : STATIONS;
  res.json(result);
});

// 3. 노선별 역 순서
app.get('/api/line-stations', (req, res) => {
  const { line } = req.query;
  if (!line) return res.status(400).json({ error: 'line 필수' });
  res.json(LINE_STATIONS[line] || []);
});

// 4. 혼잡도 예측 (특정 역·요일·방향)
app.get('/api/predict', (req, res) => {
  const { line, station, day = '평일', direction } = req.query;
  if (!line || !station) return res.status(400).json({ error: 'line, station 필수' });

  const allDirs = [...new Set(
    DB.filter(r => r.line === line && r.station === station && r.day === day).map(r => r.dir)
  )].sort();

  if (!allDirs.length) return res.status(404).json({ error: '데이터 없음', station, line, day });

  const targetDirs = direction ? [direction] : allDirs;
  const directions = targetDirs.map(dir => {
    const key = `${line}|${station}|${day}|${dir}`;
    const row = LOOKUP[key];
    if (!row) return null;
    return {
      direction: dir,
      slots: TIME_SLOTS.map((t, i) => ({
        time:       t,
        label:      slotLabel(t),
        hour:       SLOT_HOURS[i],
        congestion: Math.round(row.slots[i] * 10) / 10,
        level:      congestionLevel(row.slots[i])
      }))
    };
  }).filter(Boolean);

  if (!directions.length) return res.status(404).json({ error: '데이터 없음' });

  const ik = `${line}|${station}|${day}`;
  const insight = INSIGHT_CACHE[ik] || null;

  res.json({
    station, line, day,
    allDirections: allDirs,
    directions,
    insight: insight ? {
      grade:       insight.grade,
      avgOverall:  insight.avgOverall,
      peakPeriods: insight.peakPeriods,
      comments:    insight.comments
    } : null
  });
});

// 5. 최적 출발 시간 추천
app.get('/api/recommend', (req, res) => {
  const { line, station, day = '평일' } = req.query;
  if (!line || !station) return res.status(400).json({ error: 'line, station 필수' });

  const ik = `${line}|${station}|${day}`;
  const insight = INSIGHT_CACHE[ik];
  if (!insight) return res.status(404).json({ error: '데이터 없음', station, line });

  res.json({
    station, line, day,
    top3:    insight.top3,
    grade:   insight.grade,
    comments: insight.comments
  });
});

// 6. 히트맵 (노선 전체 역 × 시간대)
app.get('/api/heatmap', (req, res) => {
  const { line, day = '평일', direction } = req.query;
  if (!line) return res.status(400).json({ error: 'line 필수' });

  const stationList = LINE_STATIONS[line] || [];
  const stations = stationList.map(st => {
    const rows = DB.filter(r =>
      r.line === line && r.station === st && r.day === day &&
      (!direction || r.dir === direction)
    );
    if (!rows.length) return null;

    const avgSlots = TIME_SLOTS.map((_, i) => {
      const vals = rows.map(r => r.slots[i]);
      return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
    });

    return {
      station: st,
      slots: avgSlots.map((v, i) => ({
        time:       TIME_SLOTS[i],
        label:      slotLabel(TIME_SLOTS[i]),
        hour:       SLOT_HOURS[i],
        congestion: v,
        level:      congestionLevel(v)
      }))
    };
  }).filter(Boolean);

  res.json({
    line, day,
    timeSlots: TIME_SLOTS.map((t, i) => ({ slot: t, label: slotLabel(t), hour: SLOT_HOURS[i] })),
    stations
  });
});

// 7. 역 간 혼잡도 비교
app.get('/api/compare', (req, res) => {
  const { stations: sp, day = '평일', hour } = req.query;
  if (!sp) return res.status(400).json({ error: 'stations 필수 (쉼표 구분)' });

  const stList = sp.split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
  const hourNum = parseFloat(hour);

  const result = stList.map(st => {
    const rows = DB.filter(r => r.station === st && r.day === day);
    if (!rows.length) return { station: st, found: false };

    const line = rows[0].line;
    const avgSlots = TIME_SLOTS.map((_, i) => {
      const vals = rows.map(r => r.slots[i]);
      return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
    });

    if (!isNaN(hourNum)) {
      let bestIdx = 0, bestDiff = Infinity;
      SLOT_HOURS.forEach((h, i) => {
        const diff = Math.abs(h - hourNum);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
      });
      return {
        station: st, line, day, found: true,
        hour: slotLabel(TIME_SLOTS[bestIdx]),
        congestion: avgSlots[bestIdx],
        level: congestionLevel(avgSlots[bestIdx]),
        label: congestionLabel(avgSlots[bestIdx])
      };
    }

    return {
      station: st, line, day, found: true,
      slots: TIME_SLOTS.map((t, i) => ({
        time:       t,
        label:      slotLabel(t),
        hour:       SLOT_HOURS[i],
        congestion: avgSlots[i],
        level:      congestionLevel(avgSlots[i])
      }))
    };
  });

  res.json({ day, result });
});

// 8. AI 인사이트
app.get('/api/insights', (req, res) => {
  const { line, station, day = '평일' } = req.query;
  if (!line || !station) return res.status(400).json({ error: 'line, station 필수' });

  const k = `${line}|${station}|${day}`;
  const insight = INSIGHT_CACHE[k];
  if (!insight) return res.status(404).json({ error: '데이터 없음' });

  res.json({ station, line, day, ...insight });
});

// 9. 전체 통계
app.get('/api/stats', (req, res) => {
  const lines = Object.keys(LINE_STATIONS).sort();
  const lineStats = {};
  for (const ln of lines) {
    const rows = DB.filter(r => r.line === ln && r.day === '평일');
    const all = rows.flatMap(r => r.slots).filter(v => v > 0);
    lineStats[ln] = all.length
      ? Math.round(all.reduce((a, b) => a + b, 0) / all.length * 10) / 10 : 0;
  }

  // 가장 혼잡한 역 TOP5 (평일 전체 평균)
  const stationAvgs = STATIONS.filter(s => s.line.startsWith('') )
    .map(s => {
      const k = `${s.line}|${s.name}|평일`;
      const ins = INSIGHT_CACHE[k];
      return ins ? { station: s.name, line: s.line, avgOverall: ins.avgOverall } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.avgOverall - a.avgOverall);

  res.json({
    lines,
    stationCount: STATIONS.length,
    recordCount:  DB.length,
    lineStats,
    top5Congested: stationAvgs.slice(0, 5),
    top5Relaxed:   stationAvgs.slice(-5).reverse()
  });
});

// 10. 현재 시각 기준 실시간 혼잡도 (평일 기준 현재 시간대 조회)
app.get('/api/realtime', (req, res) => {
  const { line, station } = req.query;
  if (!line || !station) return res.status(400).json({ error: 'line, station 필수' });

  // 현재 시각 기준 KST
  const now = new Date();
  const kstOffset = 9 * 60;
  const kst = new Date(now.getTime() + kstOffset * 60000);
  const currentHour = kst.getUTCHours() + kst.getUTCMinutes() / 60;

  // 요일 판별
  const dayOfWeek = kst.getUTCDay(); // 0=일, 6=토
  const day = dayOfWeek === 0 ? '일요일' : dayOfWeek === 6 ? '토요일' : '평일';

  // 현재 슬롯 찾기
  let bestIdx = 0, bestDiff = Infinity;
  SLOT_HOURS.forEach((h, i) => {
    const diff = Math.abs(h - currentHour);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });

  const rows = DB.filter(r => r.line === line && r.station === station && r.day === day);
  if (!rows.length) return res.status(404).json({ error: '데이터 없음' });

  const avgCongestion = rows.reduce((sum, r) => sum + r.slots[bestIdx], 0) / rows.length;
  const nextIdx = Math.min(bestIdx + 1, TIME_SLOTS.length - 1);
  const nextCongestion = rows.reduce((sum, r) => sum + r.slots[nextIdx], 0) / rows.length;

  res.json({
    station, line, day,
    currentTime:       slotLabel(TIME_SLOTS[bestIdx]),
    currentCongestion: Math.round(avgCongestion * 10) / 10,
    currentLevel:      congestionLevel(avgCongestion),
    currentLabel:      congestionLabel(avgCongestion),
    nextTime:          slotLabel(TIME_SLOTS[nextIdx]),
    nextCongestion:    Math.round(nextCongestion * 10) / 10,
    nextLevel:         congestionLevel(nextCongestion),
    trend:             nextCongestion > avgCongestion ? 'increasing' : nextCongestion < avgCongestion ? 'decreasing' : 'stable'
  });
});

// 404
app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));

// ── 기동 ─────────────────────────────────────────────────────────
loadData();
app.listen(PORT, () => {
  console.log(`[서울 지하철 AI] http://localhost:${PORT}`);
});
