'use strict';

const { AREA_NAMES } = require('./regional-areas.js');

const AREA_TOTAL = 'Tổng hợp';
const METRIC_KEYS = Object.freeze([
    'cargoTons',
    'seaCargoTons',
    'inlandCargoTons',
    'exportTons',
    'importTons',
    'domesticTons',
    'transitLoadedTons',
    'containerTons',
    'containerTeus',
    'dryTons',
    'liquidTons',
    'totalCalls',
    'seaCalls',
    'inlandCalls',
    'internationalCalls',
    'domesticCalls',
    'islandCalls',
    'passengers',
    'seaPassengers',
    'inlandPassengers'
]);

function invalid(message) {
    throw Object.assign(new Error(message), { statusCode: 400 });
}

function parseInteger(value, label, min, max) {
    if (!/^\d+$/.test(String(value ?? ''))) invalid(`${label} không hợp lệ.`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
        invalid(`${label} không hợp lệ.`);
    }
    return number;
}

function monthKey(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
}

function currentYearMonth(now = new Date()) {
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function normalizeSummaryPeriod(params, now = new Date()) {
    const { year: thisYear, month: thisMonth } = currentYearMonth(now);
    const type = params.get('kyBaoCao') || 'nam';
    const rawYear = params.get('nam');
    const year = rawYear === null || rawYear === ''
        ? thisYear
        : parseInteger(rawYear, 'Năm', 2000, 2100);
    let months;
    let label;

    if (type === 'thang') {
        const month = parseInteger(params.get('thang'), 'Tháng', 1, 12);
        months = [monthKey(year, month)];
        label = `THÁNG ${month}/${year}`;
    } else if (type === '6thang-dau') {
        months = Array.from({ length: Math.min(6, year === thisYear ? thisMonth : 6) },
            (_, index) => monthKey(year, index + 1));
        label = `6 THÁNG ĐẦU NĂM ${year}`;
    } else if (type === '6thang-cuoi') {
        const endMonth = year === thisYear ? Math.min(12, thisMonth) : 12;
        months = endMonth < 7
            ? []
            : Array.from({ length: endMonth - 6 }, (_, index) => monthKey(year, index + 7));
        label = `6 THÁNG CUỐI NĂM ${year}`;
    } else if (type === 'nam') {
        const endMonth = year === thisYear ? thisMonth : 12;
        months = Array.from({ length: endMonth }, (_, index) => monthKey(year, index + 1));
        label = `NĂM ${year}`;
    } else if (type === '6thang-gan-nhat') {
        months = [];
        for (let offset = 5; offset >= 0; offset--) {
            const date = new Date(thisYear, thisMonth - 1 - offset, 1);
            months.push(monthKey(date.getFullYear(), date.getMonth() + 1));
        }
        label = `6 THÁNG GẦN NHẤT (${months[0]} — ${months[months.length - 1]})`;
    } else {
        invalid('Kỳ báo cáo không hợp lệ.');
    }

    return {
        kyBaoCao: type,
        nam: year,
        months,
        label
    };
}

function normalizeSummaryArea(value) {
    const area = value || AREA_TOTAL;
    if (area !== AREA_TOTAL && !AREA_NAMES.includes(area)) {
        invalid('Khu vực báo cáo không hợp lệ.');
    }
    return area;
}

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function sumValues(values) {
    const present = values.map(numberOrNull).filter(value => value !== null);
    return present.length ? present.reduce((total, value) => total + value, 0) : 0;
}

function breakdownOf(vessel) {
    return vessel.cargoBreakdown && typeof vessel.cargoBreakdown === 'object'
        ? vessel.cargoBreakdown
        : {};
}

function amountInTons(vessel, direction) {
    const amount = numberOrNull(vessel[`cargoAmount${direction}`]);
    const unit = String(vessel[`cargoUnit${direction}`] || '').trim().toLowerCase();
    return amount !== null && ['tấn', 'tan', 't', 'ton', 'tons'].includes(unit)
        ? amount
        : null;
}

function legacyCargoMetric(vessel, key) {
    const descriptors = {
        exportTons: ['xuat khau', 'xc'],
        importTons: ['nhap khau', 'nc'],
        domesticTons: ['noi dia', 'nd', 'brd'],
        transitLoadedTons: ['qua canh', 'qc']
    };
    const tokens = descriptors[key] || [];
    const total = ['In', 'Out'].reduce((sum, direction) => {
        const amount = amountInTons(vessel, direction);
        if (amount === null) return sum;
        const descriptor = [
            vessel[`cargoHandling${direction}`],
            vessel[`sourceRoute${direction === 'In' ? 'Code' : 'OutCode'}`]
        ].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/gi, 'd').toLowerCase();
        return tokens.some(token => descriptor.includes(token)) ? sum + amount : sum;
    }, 0);
    return total;
}

function metricFor(vessels, key) {
    const values = vessels.map(vessel => {
        const breakdown = breakdownOf(vessel);
        const explicit = numberOrNull(breakdown[key] ?? vessel[key]);
        if (explicit !== null) return explicit;
        return legacyCargoMetric(vessel, key);
    });
    return sumValues(values);
}

function isInland(vessel) {
    const kind = String(vessel.vesselClass || vessel.portType || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd').toLowerCase();
    return ['inland', 'thuy noi dia', 'pttnd'].includes(kind);
}

function movementType(vessel) {
    const type = String(vessel.movementType || '').trim().toLowerCase();
    if (type === 'island' || type === 'domestic' || type === 'international') return type;
    const routes = `${vessel.sourceRouteCode || ''} ${vessel.sourceRouteOutCode || ''}`.toUpperCase();
    if (routes.includes('BRĐ') || routes.includes('BRD')) return 'island';
    if (routes.includes('NĐ') || routes.includes('ND')) return 'domestic';
    if (routes.includes('NC') || routes.includes('XC')) return 'international';
    return '';
}

function summarizeVessels(vessels) {
    const all = vessels.length;
    const seaVessels = vessels.filter(vessel => !isInland(vessel));
    const inlandVessels = vessels.filter(isInland);
    const passengersFor = records => sumValues(records.flatMap(vessel => {
        const breakdown = breakdownOf(vessel);
        return [
            breakdown.passengersIn ?? vessel.passengersIn,
            breakdown.passengersOut ?? vessel.passengersOut
        ];
    }));
    const cargoTons = metricFor(vessels, 'cargoTons') ||
        sumValues(vessels.map(vessel => amountInTons(vessel, 'In') ?? 0)) +
        sumValues(vessels.map(vessel => amountInTons(vessel, 'Out') ?? 0));
    const seaCargoTons = metricFor(seaVessels, 'cargoTons');
    const inlandCargoTons = metricFor(inlandVessels, 'cargoTons');

    return {
        cargoTons,
        seaCargoTons,
        inlandCargoTons,
        exportTons: metricFor(vessels, 'exportTons'),
        importTons: metricFor(vessels, 'importTons'),
        domesticTons: metricFor(vessels, 'domesticTons'),
        transitLoadedTons: metricFor(vessels, 'transitLoadedTons'),
        containerTons: metricFor(vessels, 'containerTons'),
        containerTeus: metricFor(vessels, 'containerTeus'),
        dryTons: metricFor(vessels, 'dryTons'),
        liquidTons: metricFor(vessels, 'liquidTons'),
        totalCalls: all,
        seaCalls: seaVessels.length,
        inlandCalls: inlandVessels.length,
        internationalCalls: vessels.filter(vessel => movementType(vessel) === 'international').length,
        domesticCalls: vessels.filter(vessel => movementType(vessel) === 'domestic').length,
        islandCalls: vessels.filter(vessel => movementType(vessel) === 'island').length,
        passengers: passengersFor(vessels),
        seaPassengers: passengersFor(seaVessels),
        inlandPassengers: passengersFor(inlandVessels)
    };
}

function summarizeByArea(vessels) {
    return AREA_NAMES.map(khuVuc => ({
        khuVuc,
        ...summarizeVessels(vessels.filter(vessel => vessel.khuVuc === khuVuc))
    }));
}

function finalizeSummary(period, area, rows, dataMonths) {
    const byArea = new Map(rows.map(row => [row.khuVuc, row]));
    const areas = AREA_NAMES.map(khuVuc => ({
        khuVuc,
        ...Object.fromEntries(METRIC_KEYS.map(key => [
            key,
            numberOrNull(byArea.get(khuVuc)?.[key]) ?? 0
        ]))
    }));
    const total = {
        khuVuc: AREA_TOTAL,
        ...Object.fromEntries(METRIC_KEYS.map(key => [
            key,
            areas.reduce((sum, item) => sum + item[key], 0)
        ]))
    };
    const availableMonths = [...new Set(dataMonths)].sort();
    const completedPeriod = {
        ...period,
        dataMonths: availableMonths,
        missingMonths: period.months.filter(key => !availableMonths.includes(key))
    };

    return {
        period: completedPeriod,
        khuVuc: area,
        areas: area === AREA_TOTAL ? areas : areas.filter(item => item.khuVuc === area),
        total
    };
}

module.exports = {
    METRIC_KEYS,
    finalizeSummary,
    normalizeSummaryArea,
    normalizeSummaryPeriod,
    summarizeByArea
};
