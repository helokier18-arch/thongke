'use strict';

require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const formulaEngine = require('./monthly-formulas.js');
const ExcelJS = require('exceljs');
const { AREA_NAMES, classifyPortArea } = require('./regional-areas.js');
const {
    finalizeSummary,
    normalizeSummaryArea,
    normalizeSummaryPeriod
} = require('./summary-report.js');
const repository = require('./repository.js');

const databaseName = process.env.MONGODB_DB || 'maritime_statistics';
const buildCommit = process.env.RENDER_GIT_COMMIT || process.env.GITHUB_SHA || 'unknown';
const port = Number(process.env.PORT || process.env.API_PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const authUsername = process.env.API_AUTH_USERNAME || '';
const authPassword = process.env.API_AUTH_PASSWORD || '';
const allowedOrigin = process.env.API_CORS_ORIGIN || '';
const maxRequestBytes = 12 * 1024 * 1024;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('API_PORT must be a valid TCP port.');
    process.exit(1);
}

const allowedVesselAreas = new Set(AREA_NAMES);
const noCacheHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
};

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(payload));
}

function hasValidCredentials(request) {
    if (!authUsername || !authPassword) return true;
    const authorization = String(request.headers.authorization || '');
    const match = authorization.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
    if (!match) return false;

    let supplied;
    try {
        supplied = Buffer.from(match[1], 'base64').toString('utf8');
    } catch {
        return false;
    }
    const separator = supplied.indexOf(':');
    if (separator < 0) return false;

    const suppliedUsername = Buffer.from(supplied.slice(0, separator));
    const expectedUsername = Buffer.from(authUsername);
    const suppliedPassword = Buffer.from(supplied.slice(separator + 1));
    const expectedPassword = Buffer.from(authPassword);
    const usernameMatches = suppliedUsername.length === expectedUsername.length &&
        timingSafeEqual(suppliedUsername, expectedUsername);
    const passwordMatches = suppliedPassword.length === expectedPassword.length &&
        timingSafeEqual(suppliedPassword, expectedPassword);
    return usernameMatches && passwordMatches;
}

function requireAuthentication(request, response) {
    if (!authUsername || !authPassword || request.url.split('?')[0] === '/api/health') return true;
    if (hasValidCredentials(request)) return true;
    response.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Maritime Statistics", charset="UTF-8"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end('Authentication required.');
    return false;
}

function applyCors(request, response) {
    const origin = request.headers.origin;
    if (origin && allowedOrigin && origin === allowedOrigin) {
        response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
}

async function serveStaticFile(requestPath, response) {
    const relativePath = requestPath === '/' ? 'main.html' : decodeURIComponent(requestPath.slice(1));
    const publicFiles = new Map([
        ['main.html', 'text/html; charset=utf-8'],
        ['monthly-formulas.js', 'text/javascript; charset=utf-8'],
        ['regional-areas.js', 'text/javascript; charset=utf-8']
    ]);
    const contentType = publicFiles.get(relativePath);
    if (!contentType) return false;

    const filePath = path.resolve(__dirname, relativePath);
    if (!filePath.startsWith(`${__dirname}${path.sep}`)) {
        response.writeHead(403);
        response.end('Forbidden.');
        return true;
    }

    try {
        const content = await fs.readFile(filePath);
        response.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(content);
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
    return true;
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let receivedBytes = 0;
        let settled = false;

        request.on('data', chunk => {
            if (settled) return;
            receivedBytes += chunk.length;
            if (receivedBytes > maxRequestBytes) {
                settled = true;
                reject(Object.assign(new Error('Request body exceeds the 12 MiB limit.'), { statusCode: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        request.on('error', error => {
            if (!settled) reject(error);
        });
        request.on('end', () => {
            if (settled) return;
            settled = true;
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
            }
        });
    });
}

function readBufferBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let receivedBytes = 0;
        let settled = false;
        request.on('data', chunk => {
            if (settled) return;
            receivedBytes += chunk.length;
            if (receivedBytes > maxRequestBytes) {
                settled = true;
                reject(Object.assign(new Error('File exceeds the 12 MiB limit.'), { statusCode: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        request.on('error', error => {
            if (!settled) reject(error);
        });
        request.on('end', () => {
            if (!settled) {
                settled = true;
                resolve(Buffer.concat(chunks));
            }
        });
    });
}

function isValidVesselArea(area) {
    return typeof area === 'string' && allowedVesselAreas.has(area);
}

function normalizedIdentity(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function vesselDeduplicationKey(vessel) {
    const callSign = normalizedIdentity(vessel.callSign);
    const identity = !callSign || callSign === 'NA'
        ? normalizedIdentity(vessel.shipName)
        : callSign;
    const dateIn = String(vessel.dateIn ?? '').trim();
    const port = normalizedIdentity(vessel.port);
    if (!identity || !dateIn || !port) return '';
    return [vessel.khuVuc, identity, dateIn, port].join('|');
}

function validateVessel(vessel) {
    if (!vessel || typeof vessel !== 'object' || Array.isArray(vessel)) {
        return 'Dữ liệu dòng không phải một đối tượng hợp lệ.';
    }
    if (!isValidVesselArea(vessel.khuVuc)) {
        return 'Khu vực không hợp lệ hoặc chưa được chọn.';
    }
    if (typeof vessel.shipName !== 'string' || !vessel.shipName.trim()) {
        return 'Thiếu tên tàu.';
    }
    if (typeof vessel.callSign !== 'string' || typeof vessel.dateIn !== 'string' ||
        typeof vessel.port !== 'string') {
        return 'Hô hiệu, ngày đến và cảng/bến phải là văn bản.';
    }
    if (!vesselDeduplicationKey(vessel)) {
        return 'Không đủ dữ liệu tạo khóa chống trùng (hô hiệu/tên tàu, ngày đến, cảng/bến).';
    }
    return '';
}

function normalizeMonthKey(value) {
    return typeof value === 'string' &&
        (/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value === 'current')
        ? value
        : '';
}

function excelDateToIso(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
        if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
    }
    const text = String(value ?? '').trim();
    const isoDate = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoDate) return `${isoDate[1]}-${isoDate[2].padStart(2, '0')}-${isoDate[3].padStart(2, '0')}`;
    const localDate = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (localDate) return `${localDate[3]}-${localDate[2].padStart(2, '0')}-${localDate[1].padStart(2, '0')}`;
    return '';
}

async function parseExcelVessels(buffer, requestedArea) {
    const workbook = new ExcelJS.Workbook();
    try {
        await workbook.xlsx.load(buffer);
    } catch {
        throw Object.assign(new Error('Không đọc được file XLSX. Hãy chọn file Excel hoặc CSV hợp lệ.'), { statusCode: 400 });
    }
    for (const worksheet of workbook.worksheets) {
        const rows = [];
        worksheet.eachRow({ includeEmpty: true }, row => {
            rows[row.number - 1] = Array.from(
                { length: worksheet.columnCount },
                (_, index) => row.getCell(index + 1).value
            );
        });
        const normalizeHeader = value => String(value?.text ?? value ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/gi, 'd')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
        const headerIndex = rows.findIndex(row => {
            const headers = row.map(normalizeHeader);
            return headers.includes('ten tau') && headers.includes('grt') && headers.includes('dwt');
        });
        if (headerIndex < 0) continue;

        const headers = rows[headerIndex].map(normalizeHeader);
        const column = (...names) => headers.findIndex(header =>
            names.some(name => header === name || header.startsWith(`${name} `))
        );
        const columns = {
            shipName: column('ten tau'),
            flag: column('quoc tich'),
            shipType: column('loai tau'),
            grt: column('grt'),
            dwt: column('dwt'),
            callSign: column('ho hieu'),
            imo: column('so imo'),
            length: column('chieu dai'),
            draft: column('mon nuoc'),
            clearanceHeight: column('chieu cao tinh khong'),
            cargoNameIn: column('ten hang den', 'hang hoa den'),
            cargoTypeIn: column('loai hang den'),
            cargoHandlingIn: column('hinh thuc hang den'),
            cargoAmountIn: column('so luong hang den'),
            cargoUnitIn: column('don vi hang den'),
            cargoNameOut: column('ten hang roi', 'hang hoa roi'),
            cargoTypeOut: column('loai hang roi'),
            cargoHandlingOut: column('hinh thuc hang roi'),
            cargoAmountOut: column('so luong hang roi'),
            cargoUnitOut: column('don vi hang roi'),
            passengersIn: column('luot khach den', 'hanh khach den'),
            passengersOut: column('luot khach roi', 'hanh khach roi'),
            lastPort: column('cang roi cuoi', 'cang truoc'),
            dateIn: column('ngay den'),
            dateOut: column('ngay roi'),
            port: column('ben lam hang', 'cang lam hang'),
            portArea: column('khu vuc', 'khu vuc cang', 'khu vuc ben', 'region'),
            nextPort: column('cang den tiep theo', 'cang tiep theo'),
            agent: column('dai ly')
        };
        const parseNumber = value => {
            if (value && typeof value === 'object' && typeof value.result === 'number') value = value.result;
            if (typeof value === 'number') return Number.isFinite(value) ? value : null;
            const text = String(value?.text ?? value ?? '').replace(/\s/g, '').trim();
            if (!text) return null;
            const normalized = text.includes(',') && text.includes('.')
                ? (text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, ''))
                : text.replace(',', '.');
            const number = Number(normalized);
            return Number.isFinite(number) ? number : null;
        };
        const vessels = [];
        const errors = [];
        rows.slice(headerIndex + 1).forEach((row, index) => {
            const line = headerIndex + index + 2;
            if (!row) return;
            const shipName = String(row[columns.shipName] ?? '').trim();
            if (!shipName) return;
            const grt = parseNumber(row[columns.grt]);
            const dwt = parseNumber(row[columns.dwt]);
            const callSign = String(row[columns.callSign] ?? '').trim() || 'N/A';
            const dateIn = excelDateToIso(row[columns.dateIn]);
            const port = String(row[columns.port] ?? '').trim();
            const portArea = String(row[columns.portArea] ?? '').trim();
            const area = requestedArea === 'auto'
                ? (port ? classifyPortArea(port, portArea) : null)
                : requestedArea;
            if (!area) {
                errors.push({
                    row: line,
                    reason: port
                        ? `Không xác định được khu vực từ cảng/bến "${port}".`
                        : 'Thiếu cảng/bến làm hàng để xác định khu vực.'
                });
                return;
            }
            const text = columnIndex => String(row[columnIndex] ?? '').trim();
            const cargoAmountIn = parseNumber(row[columns.cargoAmountIn]);
            const cargoAmountOut = parseNumber(row[columns.cargoAmountOut]);
            const cargoUnitIn = text(columns.cargoUnitIn);
            const cargoUnitOut = text(columns.cargoUnitOut);
            const isTons = unit => ['t', 'tan', 'ton', 'tons'].includes(
                normalizeHeader(unit).replace(/\s/g, '')
            );
            const draftValue = text(columns.draft).split('/')[0];
            const portType = /\btnd\b|\bthuy noi dia\b/.test(normalizeHeader(port))
                ? 'inland'
                : 'sea';
            const vessel = {
                id: Date.now() + index,
                sourceRow: line,
                khuVuc: area,
                shipName: shipName.toUpperCase(),
                flag: text(columns.flag),
                shipType: text(columns.shipType) || 'Không rõ',
                vesselClass: portType,
                portType,
                callSign,
                imo: String(row[columns.imo] ?? '').trim(),
                grt: grt ?? 0,
                dwt: dwt ?? 0,
                length: parseNumber(row[columns.length]) ?? 0,
                draft: parseNumber(draftValue) ?? 0,
                clearanceHeight: parseNumber(row[columns.clearanceHeight]),
                cargoNameIn: text(columns.cargoNameIn),
                cargoTypeIn: text(columns.cargoTypeIn),
                cargoHandlingIn: text(columns.cargoHandlingIn),
                cargoAmountIn,
                cargoUnitIn,
                cargoNameOut: text(columns.cargoNameOut),
                cargoTypeOut: text(columns.cargoTypeOut),
                cargoHandlingOut: text(columns.cargoHandlingOut),
                cargoAmountOut,
                cargoUnitOut,
                cargoType: [...new Set([text(columns.cargoTypeIn), text(columns.cargoTypeOut)].filter(Boolean))]
                    .join(', ') || 'Không rõ',
                cargoAmount: (isTons(cargoUnitIn) ? cargoAmountIn || 0 : 0) +
                    (isTons(cargoUnitOut) ? cargoAmountOut || 0 : 0),
                cargoBreakdown: {
                    dryTons: null,
                    liquidTons: null,
                    containerTons: null,
                    containerTeus: null,
                    cargoInTons: isTons(cargoUnitIn) ? cargoAmountIn : null,
                    cargoOutTons: isTons(cargoUnitOut) ? cargoAmountOut : null,
                    passengersIn: parseNumber(row[columns.passengersIn]),
                    passengersOut: parseNumber(row[columns.passengersOut])
                },
                dateIn,
                dateOut: excelDateToIso(row[columns.dateOut]),
                lastPort: text(columns.lastPort) || 'N/A',
                port,
                nextPort: text(columns.nextPort) || 'N/A',
                agent: text(columns.agent) || 'N/A'
            };
            const error = grt === null || grt <= 0 || dwt === null || dwt <= 0
                ? 'GRT/DWT phải là số lớn hơn 0.'
                : validateVessel(vessel);
            if (error) errors.push({ row: line, reason: error });
            else vessels.push(vessel);
        });
        return { vessels, errors };
    }
    throw Object.assign(new Error('Không tìm thấy sheet có các cột Tên tàu, GRT và DWT.'), { statusCode: 400 });
}

function decodeDatasetKey(encodedKey) {
    let key;
    try {
        key = decodeURIComponent(encodedKey);
    } catch {
        return null;
    }
    if (!key || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) return null;
    return key;
}

function isValidDataset(data) {
    return data && typeof data === 'object' && !Array.isArray(data) &&
        Array.isArray(data.vessels) &&
        data.vessels.every(vessel =>
            vessel && typeof vessel === 'object' && !Array.isArray(vessel) &&
            typeof vessel.shipName === 'string' &&
            (vessel.khuVuc === undefined || isValidVesselArea(vessel.khuVuc))
        );
}

function isValidApplicationState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state) ||
        state.version !== 3 || typeof state.activeMonthKey !== 'string' ||
        !state.monthDatasets || typeof state.monthDatasets !== 'object' ||
        Array.isArray(state.monthDatasets)) return false;

    const entries = Object.entries(state.monthDatasets);
    return entries.length > 0 &&
        Object.prototype.hasOwnProperty.call(state.monthDatasets, state.activeMonthKey) &&
        entries.every(([key, dataset]) =>
            key && !['__proto__', 'prototype', 'constructor'].includes(key) &&
            dataset && typeof dataset === 'object' && !Array.isArray(dataset) &&
            Array.isArray(dataset.vessels) &&
            dataset.vessels.every(vessel =>
                vessel && typeof vessel === 'object' && !Array.isArray(vessel) &&
                typeof vessel.shipName === 'string' &&
                (vessel.khuVuc === undefined || isValidVesselArea(vessel.khuVuc))
            )
        );
}

async function saveApplicationState(state) {
    if (!isValidApplicationState(state)) {
        throw Object.assign(new Error('Trạng thái ứng dụng hoặc khu vực tàu không hợp lệ.'), { statusCode: 400 });
    }
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > maxRequestBytes) {
        throw Object.assign(new Error('Application state exceeds the 12 MiB request limit.'), { statusCode: 413 });
    }
    return repository.saveApplicationState(state);
}

async function getOrCreateApplicationState(monthKey) {
    const saved = await repository.getState();
    if (saved.state) return saved.state;
    return {
        version: 3,
        activeMonthKey: monthKey,
        monthDatasets: { [monthKey]: { vessels: [] } }
    };
}

function upsertVesselsIntoState(state, monthKey, incomingVessels) {
    if (!state.monthDatasets[monthKey]) state.monthDatasets[monthKey] = { vessels: [] };
    const targetDataset = state.monthDatasets[monthKey];
    if (!Array.isArray(targetDataset.vessels)) targetDataset.vessels = [];
    const usedIds = new Set(Object.values(state.monthDatasets)
        .flatMap(dataset => Array.isArray(dataset.vessels) ? dataset.vessels : [])
        .map(vessel => String(vessel.id))
        .filter(id => id !== 'undefined'));
    let nextGeneratedId = Date.now();
    const createUniqueId = () => {
        while (usedIds.has(String(nextGeneratedId))) nextGeneratedId++;
        const id = nextGeneratedId++;
        usedIds.add(String(id));
        return id;
    };
    let inserted = 0;
    let updated = 0;
    const canonicalVessels = [];

    incomingVessels.forEach((vessel, index) => {
        const deduplicationKey = vesselDeduplicationKey(vessel);
        let existing = null;
        let existingMonth = '';
        let existingIndex = -1;
        for (const [candidateMonth, dataset] of Object.entries(state.monthDatasets)) {
            const candidateVessels = Array.isArray(dataset.vessels) ? dataset.vessels : [];
            const foundIndex = candidateVessels.findIndex(candidate =>
                candidate.khuVuc === vessel.khuVuc &&
                vesselDeduplicationKey(candidate) === deduplicationKey
            );
            if (foundIndex >= 0) {
                existing = candidateVessels[foundIndex];
                existingMonth = candidateMonth;
                existingIndex = foundIndex;
                break;
            }
        }
        let normalized;
        if (existing) {
            normalized = { ...existing, ...vessel, id: existing.id ?? vessel.id };
        } else {
            const requestedId = vessel.id;
            const id = requestedId !== undefined && requestedId !== null &&
                !usedIds.has(String(requestedId))
                ? requestedId
                : createUniqueId();
            usedIds.add(String(id));
            normalized = { ...vessel, id };
        }
        if (existing) {
            state.monthDatasets[existingMonth].vessels.splice(existingIndex, 1);
            updated++;
        } else {
            inserted++;
        }
        targetDataset.vessels.push(normalized);
        canonicalVessels.push(normalized);
    });
    state.activeMonthKey = monthKey;
    return { inserted, updated, canonicalVessels };
}

async function handleRequest(request, response) {
    applyCors(request, response);

    if (!requireAuthentication(request, response)) return;

    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }

    const url = new URL(request.url, 'http://127.0.0.1');
    // Accept API paths with or without a trailing slash.
    while (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);

    if (request.method === 'GET' && url.pathname === '/api/version') {
        sendJson(response, 200, {
            service: 'maritime-vessel-statistics-api',
            version: require('./package.json').version,
            commit: buildCommit,
            node: process.version,
            database: databaseName
        });
        return;
    }

    if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (await serveStaticFile(url.pathname, response)) return;
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
        try {
            await repository.pool.query('SELECT 1');
        } catch (error) {
            console.error(`MongoDB health check failed: ${error.message}`);
            sendJson(response, 503, {
                status: 'error',
                database: databaseName,
                error: 'Không thể kết nối MongoDB Atlas. Hãy kiểm tra cấu hình dịch vụ và quyền truy cập mạng.'
            });
            return;
        }
        sendJson(response, 200, {
            status: 'ok',
            database: databaseName,
            commit: buildCommit
        });
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/state/meta') {
        sendJson(response, 200, await repository.getStateMeta());
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, await repository.getState());
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/vessels') {
        const area = url.searchParams.get('khuVuc');
        if (area !== 'Tổng hợp' && !isValidVesselArea(area)) {
            sendJson(response, 400, { error: 'khuVuc không hợp lệ. Hãy chọn một trong sáu khu vực hoặc Tổng hợp.' });
            return;
        }
        const monthKey = url.searchParams.get('monthKey');
        if (monthKey && !normalizeMonthKey(monthKey)) {
            sendJson(response, 400, { error: 'monthKey không hợp lệ.' });
            return;
        }
        const vessels = await repository.listVessels(area, monthKey || null);
        sendJson(response, 200, { khuVuc: area, count: vessels.length, vessels });
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/tong-hop') {
        const period = normalizeSummaryPeriod(url.searchParams);
        const area = normalizeSummaryArea(url.searchParams.get('khuVuc'));
        const { rows, dataMonths } = await repository.getSummaryRows(period);
        sendJson(response, 200, finalizeSummary(period, area, rows, dataMonths));
        return;
    }

        if (request.method === 'POST' && url.pathname === '/api/vessels') {
            if (!String(request.headers['content-type'] || '').includes('application/json')) {
                sendJson(response, 415, { error: 'Content-Type must be application/json.' });
                return;
            }
            const payload = await readJsonBody(request);
            const monthKey = normalizeMonthKey(payload?.monthKey);
            const vessel = payload?.vessel;
            const invalidReason = validateVessel(vessel);
            if (!monthKey || invalidReason) {
                sendJson(response, 400, { error: invalidReason || 'monthKey không hợp lệ.' });
                return;
            }
            const state = await getOrCreateApplicationState(monthKey);
            const result = upsertVesselsIntoState(state, monthKey, [vessel]);
            const saved = await saveApplicationState(state);
            sendJson(response, 200, {
                vessel: result.canonicalVessels[0],
                action: result.inserted ? 'inserted' : 'updated',
                updatedAt: saved.updatedAt
            });
            return;
        }

        if (request.method === 'POST' && url.pathname === '/api/vessels/import') {
            const requestedArea = url.searchParams.get('khuVuc');
            const monthKey = normalizeMonthKey(url.searchParams.get('monthKey'));
            if ((requestedArea !== 'auto' && !isValidVesselArea(requestedArea)) || !monthKey) {
                sendJson(response, 400, { error: 'Khu vực hoặc kỳ báo cáo không hợp lệ.' });
                return;
            }
            const contentType = String(request.headers['content-type'] || '').toLowerCase();
            if (!contentType.includes('spreadsheetml') && !contentType.includes('ms-excel') &&
                !contentType.includes('octet-stream') && !contentType.includes('text/csv')) {
                sendJson(response, 415, { error: 'Content-Type phải là file Excel hoặc CSV.' });
                return;
            }
            const buffer = await readBufferBody(request);
            if (!buffer.length) {
                sendJson(response, 400, { error: 'File nhập đang trống.' });
                return;
            }
            const parsed = await parseExcelVessels(buffer, requestedArea);
            if (parsed.vessels.length) {
                const state = await getOrCreateApplicationState(monthKey);
                const result = upsertVesselsIntoState(state, monthKey, parsed.vessels);
                const saved = await saveApplicationState(state);
                sendJson(response, 200, {
                    khuVuc: requestedArea,
                    khuVucs: [...new Set(result.canonicalVessels.map(vessel => vessel.khuVuc))],
                    monthKey,
                    inserted: result.inserted,
                    updated: result.updated,
                    skipped: parsed.errors.length,
                    errors: parsed.errors,
                    vessels: result.canonicalVessels,
                    updatedAt: saved.updatedAt
                });
            } else {
                sendJson(response, 200, {
                    khuVuc: requestedArea,
                    khuVucs: [],
                    monthKey,
                    inserted: 0,
                    updated: 0,
                    skipped: parsed.errors.length,
                    errors: parsed.errors,
                    vessels: []
                });
            }
            return;
        }

        const vesselRoute = url.pathname.match(/^\/api\/vessels\/([^/]+)\/([^/]+)$/);
        if (vesselRoute) {
            const monthKey = decodeDatasetKey(vesselRoute[1]);
            const vesselId = decodeDatasetKey(vesselRoute[2]);
            if (!monthKey || !normalizeMonthKey(monthKey) || !vesselId) {
                sendJson(response, 400, { error: 'Kỳ báo cáo hoặc mã lượt tàu không hợp lệ.' });
                return;
            }
            const saved = await repository.getState();
            if (!saved.state?.monthDatasets?.[monthKey]) {
                sendJson(response, 404, { error: 'Không tìm thấy kỳ báo cáo.' });
                return;
            }
            const state = saved.state;
            const vesselList = state.monthDatasets[monthKey].vessels;
            const index = vesselList.findIndex(item => String(item.id) === vesselId);
            if (index < 0) {
                sendJson(response, 404, { error: 'Không tìm thấy lượt tàu.' });
                return;
            }

            if (request.method === 'DELETE') {
                const area = url.searchParams.get('khuVuc');
                if (!isValidVesselArea(area) || vesselList[index].khuVuc !== area) {
                    sendJson(response, 400, { error: 'Khu vực không khớp với lượt tàu cần xóa.' });
                    return;
                }
                vesselList.splice(index, 1);
                const result = await saveApplicationState(state);
                sendJson(response, 200, { monthKey, id: vesselId, deleted: true, updatedAt: result.updatedAt });
                return;
            }

            if (request.method === 'PUT') {
                if (!String(request.headers['content-type'] || '').includes('application/json')) {
                    sendJson(response, 415, { error: 'Content-Type must be application/json.' });
                    return;
                }
                const payload = await readJsonBody(request);
                const invalidReason = validateVessel(payload?.vessel);
                if (invalidReason) {
                    sendJson(response, 400, { error: invalidReason });
                    return;
                }
                const previous = vesselList.splice(index, 1)[0];
                const replacement = { ...payload.vessel, id: previous.id };
                const upsert = upsertVesselsIntoState(state, monthKey, [replacement]);
                const result = await saveApplicationState(state);
                sendJson(response, 200, {
                    vessel: upsert.canonicalVessels[0],
                    action: 'updated',
                    updatedAt: result.updatedAt
                });
                return;
            }
        }

    if (request.method === 'GET' && url.pathname.startsWith('/api/calculate/')) {
        const monthKey = decodeDatasetKey(url.pathname.split('/').pop());
        if (!monthKey) {
            sendJson(response, 400, { error: 'Dataset key is invalid.' });
            return;
        }

        const item = await repository.getDataset(monthKey);
        if (!item) {
            sendJson(response, 404, { error: 'Dataset was not found.' });
            return;
        }

        try {
            const data = item.data;
            const records = data.vessels || [];
            const sheetView = data.monthlySheetView;

            if (!sheetView) {
                sendJson(response, 400, { error: 'Monthly sheet view is missing in dataset.' });
                return;
            }

            // Thực hiện tính toán bằng engine đã extract
            const result = formulaEngine.calculateMonthlySheet(sheetView, records, {
                getMonthlySheetAssignments: formulaEngine.getMonthlySheetAssignments,
                reportBaseline: data.reportBaseline || null,
                reportPeriod: data.reportImportSummary?.period || '',
            });

            sendJson(response, 200, {
                monthKey,
                calculatedAt: new Date(),
                summary: {
                    vesselCount: records.length,
                    rowCount: result?.rowCount || 0,
                    formulaErrors: result?.formulaErrors || 0
                },
                result
            });
        } catch (error) {
            console.error(`Calculation failed for ${monthKey}:`, error);
            sendJson(response, 500, { error: `Lỗi tính toán: ${error.message}` });
        }
        return;
    }


    if (request.method === 'PUT' && url.pathname === '/api/state') {
        if (!String(request.headers['content-type'] || '').includes('application/json')) {
            sendJson(response, 415, { error: 'Content-Type must be application/json.' });
            return;
        }
        const state = await readJsonBody(request);
        if (!isValidApplicationState(state)) {
            sendJson(response, 400, { error: 'Application state must contain valid version 3 monthly datasets and an active month key.' });
            return;
        }
        try {
            sendJson(response, 200, await saveApplicationState(state));
        } catch (error) {
            if (error.statusCode) throw error;
            console.error(`Could not save application state: ${error.message}`);
            throw Object.assign(new Error('Không thể lưu trạng thái ứng dụng vào MongoDB.'), { statusCode: 500 });
        }
        return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/main.html')) {
        const html = await fs.readFile(path.join(__dirname, 'main.html'));
        response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(html);
        return;
    }

    if (request.method === 'GET' && url.pathname === '/monthly-formulas.js') {
        const script = await fs.readFile(path.join(__dirname, 'monthly-formulas.js'));
        response.writeHead(200, {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(script);
        return;
    }

    if (request.method === 'GET' && url.pathname === '/report-template.xlsx') {
        const template = await fs.readFile(path.join(__dirname, 'report-template.xlsx'));
        response.writeHead(200, {
            'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Length': template.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(template);
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/datasets') {
        sendJson(response, 200, { datasets: await repository.listDatasets() });
        return;
    }

    const datasetRoute = url.pathname.match(/^\/api\/datasets\/([^/]+)$/);
    if (datasetRoute) {
        const key = decodeDatasetKey(datasetRoute[1]);
        if (!key) {
            sendJson(response, 400, { error: 'Dataset key is invalid.' });
            return;
        }

        if (request.method === 'GET') {
            const item = await repository.getDataset(key);
            if (!item) {
                sendJson(response, 404, { error: 'Dataset was not found.' });
                return;
            }
            sendJson(response, 200, item);
            return;
        }

        if (request.method === 'PUT') {
            if (!String(request.headers['content-type'] || '').includes('application/json')) {
                sendJson(response, 415, { error: 'Content-Type must be application/json.' });
                return;
            }
            const data = await readJsonBody(request);
            if (!isValidDataset(data)) {
                sendJson(response, 400, { error: 'Dataset must contain a vessels array of records with shipName.' });
                return;
            }
            await repository.saveDataset(key, data);
            sendJson(response, 200, { key, vesselCount: data.vessels.length });
            return;
        }

        if (request.method === 'DELETE') {
            const deleted = await repository.deleteDataset(key);
            if (!deleted) {
                sendJson(response, 404, { error: 'Dataset was not found.' });
                return;
            }
            sendJson(response, 200, { key, deleted: true });
            return;
        }
    }

    sendJson(response, 404, { error: 'API route was not found.' });
}

async function main() {
    const server = http.createServer((request, response) => {
        handleRequest(request, response).catch(error => {
            console.error(`API request failed: ${error.message}`);
            if (response.headersSent || response.destroyed) return;
            sendJson(response, error.statusCode || 500, {
                error: error.statusCode ? error.message : 'The request could not be completed.',
                ...(error.databaseSaved ? { databaseSaved: true, updatedAt: error.updatedAt } : {})
            });
        });
    });

    server.listen(port, host, () => {
        console.log(`Maritime statistics API listening at http://${host}:${port}`);
        console.log(`MongoDB database: ${databaseName}`);
    });

    const shutdown = () => {
        server.close(async () => {
            await repository.pool.end();
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch(async error => {
        console.error(`Could not start the MongoDB API: ${error.message}`);
        await repository.pool.end();
        process.exit(1);
    });
}

module.exports = { parseExcelVessels };
