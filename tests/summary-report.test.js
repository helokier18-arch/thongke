'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    finalizeSummary,
    normalizeSummaryArea,
    normalizeSummaryPeriod,
    summarizeByArea
} = require('../summary-report.js');
const { AREA_NAMES, classifyPortArea } = require('../regional-areas.js');

test('area classification only returns a known area for recognizable port names', () => {
    assert.equal(classifyPortArea('Bến cảng Cửa Việt'), 'Cửa Việt');
    assert.equal(classifyPortArea('Bến cảng Cồn Cỏ'), 'Cồn Cỏ');
    assert.equal(classifyPortArea('Cảng khách'), 'Cửa Việt');
    assert.equal(AREA_NAMES.length, 6);
});

test('known loading berths and legacy berth names map to their areas', () => {
    const { PORTS_BY_AREA } = require('../regional-areas.js');
    for (const [area, ports] of Object.entries(PORTS_BY_AREA)) {
        assert.ok(ports.length > 0, `${area} should have loading berths`);
        for (const port of ports) {
            assert.equal(classifyPortArea(port), area, port);
        }
    }
    assert.equal(classifyPortArea('Hợp Thịnh'), 'Cửa Việt');
    assert.equal(classifyPortArea('HỢP THỊNH'), 'Cửa Việt');
    assert.equal(classifyPortArea('Bến cảng Nhiệt điện Quảng Trạch 1'), 'Hòn La');
});

test('berth classification takes precedence over a conflicting Excel area', () => {
    assert.equal(classifyPortArea('Bến cảng PTSC Hòn La', 'Cửa Việt'), 'Hòn La');
    assert.equal(classifyPortArea('Bến chưa có trong danh mục', 'Cửa Việt'), 'Cửa Việt');
});

test('monthly summary period validates and returns a month key', () => {
    const period = normalizeSummaryPeriod(
        new URLSearchParams('kyBaoCao=thang&nam=2026&thang=11'),
        new Date(2026, 10, 25)
    );
    assert.deepEqual(period.months, ['2026-11']);
    assert.equal(period.label, 'THÁNG 11/2026');
});

test('invalid area and month are rejected with client errors', () => {
    assert.throws(
        () => normalizeSummaryArea('Cảng lạ'),
        error => error.statusCode === 400
    );
    assert.throws(
        () => normalizeSummaryPeriod(
            new URLSearchParams('kyBaoCao=thang&nam=2026&thang=13')
        ),
        error => error.statusCode === 400
    );
});

test('summary totals are calculated from the six area rows', () => {
    const rows = summarizeByArea([
        {
            khuVuc: 'Cửa Việt',
            vesselClass: 'sea',
            movementType: 'international',
            cargoBreakdown: { cargoTons: 25, exportTons: 25 }
        },
        {
            khuVuc: 'Cồn Cỏ',
            vesselClass: 'inland',
            movementType: 'domestic',
            cargoBreakdown: { cargoTons: 10 }
        }
    ]);
    const result = finalizeSummary(
        { kyBaoCao: 'thang', nam: 2026, months: ['2026-11'], label: 'THÁNG 11/2026' },
        'Tổng hợp',
        rows,
        ['2026-11']
    );
    assert.equal(result.areas.length, 6);
    assert.equal(result.total.cargoTons, 35);
    assert.equal(result.total.totalCalls, 2);
    assert.deepEqual(result.period.missingMonths, []);
});
