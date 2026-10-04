'use strict';

require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { BSON, MongoClient } = require('mongodb');

const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB || 'maritime_statistics';
const port = Number(process.env.PORT || process.env.API_PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const authUsername = process.env.API_AUTH_USERNAME || '';
const authPassword = process.env.API_AUTH_PASSWORD || '';
const allowedOrigin = process.env.API_CORS_ORIGIN || '';
const maxRequestBytes = 12 * 1024 * 1024;

if (!mongoUri) {
    console.error('MONGODB_URI is required. Configure it in your environment before starting the API.');
    process.exit(1);
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('API_PORT must be a valid TCP port.');
    process.exit(1);
}

if (host !== '127.0.0.1' && host !== '::1' && (!authUsername || !authPassword)) {
    console.error('API_AUTH_USERNAME and API_AUTH_PASSWORD are required when binding beyond localhost.');
    process.exit(1);
}

const mongoClient = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 5000
});

const databaseBackupPath = path.join(__dirname, 'database-backup.json');
let datasets;
let applicationStates;
let databaseBackupQueue = Promise.resolve();

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
        response.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
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
            typeof vessel.shipName === 'string'
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
                typeof vessel.shipName === 'string'
            )
        );
}

function writeDatabaseBackup(state, applicationStateDocument) {
    const write = databaseBackupQueue.then(async () => {
        const datasetDocuments = await datasets.find({ source: 'application-state' })
            .sort({ _id: 1 })
            .toArray();
        const backup = {
            format: 'maritime-statistics-mongodb-backup',
            version: 1,
            database: databaseName,
            backedUpAt: new Date().toISOString(),
            collections: {
                applicationState: [applicationStateDocument],
                datasets: datasetDocuments
            }
        };
        const temporaryPath = `${databaseBackupPath}.${process.pid}.${Date.now()}.tmp`;
        try {
            await fs.writeFile(temporaryPath, `${JSON.stringify(backup, null, 2)}\n`, {
                encoding: 'utf8',
                flag: 'wx'
            });
            await fs.rename(temporaryPath, databaseBackupPath);
            return backup.backedUpAt;
        } catch (error) {
            try {
                await fs.unlink(temporaryPath);
            } catch (cleanupError) {
                if (cleanupError.code !== 'ENOENT') {
                    console.error(`Could not remove temporary backup file: ${cleanupError.message}`);
                }
            }
            throw error;
        }
    });
    databaseBackupQueue = write.catch(() => {});
    return write;
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
    if (request.method === 'GET' && url.pathname === '/api/health') {
        await mongoClient.db(databaseName).command({ ping: 1 });
        sendJson(response, 200, { status: 'ok', database: databaseName });
        return;
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
        const savedState = await applicationStates.findOne({ _id: 'current' });
        sendJson(response, 200, { state: savedState?.state || null, updatedAt: savedState?.updatedAt || null });
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
        if (BSON.calculateObjectSize({ _id: 'current', state, updatedAt: new Date() }) > 15 * 1024 * 1024) {
            sendJson(response, 413, { error: 'Application state exceeds the 15 MiB MongoDB document limit.' });
            return;
        }
        const monthEntries = Object.entries(state.monthDatasets);
        const datasetOperations = monthEntries.map(([key, data]) => {
            const document = {
                _id: key,
                data,
                vesselCount: data.vessels.length,
                source: 'application-state',
                updatedAt: new Date()
            };
            if (BSON.calculateObjectSize(document) > 15 * 1024 * 1024) {
                throw Object.assign(new Error(`Dataset "${key}" exceeds the 15 MiB MongoDB document limit.`), { statusCode: 413 });
            }
            return {
                replaceOne: {
                    filter: { _id: key },
                    replacement: document,
                    upsert: true
                }
            };
        });
        const expectedKeys = monthEntries.map(([key]) => key);
        await datasets.bulkWrite(datasetOperations, { ordered: true });
        await datasets.deleteMany({
            source: 'application-state',
            _id: { $nin: expectedKeys }
        });
        const writeResult = await applicationStates.replaceOne(
            { _id: 'current' },
            { _id: 'current', state, updatedAt: new Date() },
            { upsert: true, writeConcern: { w: 'majority', wtimeout: 10000 } }
        );
        if (!writeResult.acknowledged) {
            throw new Error('MongoDB did not acknowledge the application state write.');
        }
        const confirmed = await applicationStates.findOne({ _id: 'current' });
        if (!confirmed || confirmed.state?.activeMonthKey !== state.activeMonthKey) {
            throw new Error('MongoDB did not confirm the saved application state.');
        }
        const confirmedDatasetCount = await datasets.countDocuments({
            source: 'application-state',
            _id: { $in: expectedKeys }
        });
        if (confirmedDatasetCount !== expectedKeys.length) {
            throw new Error('MongoDB did not confirm every saved monthly dataset.');
        }
        let backupUpdatedAt;
        try {
            backupUpdatedAt = await writeDatabaseBackup(state, confirmed);
        } catch (error) {
            console.error(`MongoDB save succeeded, but local database backup failed: ${error.message}`);
            sendJson(response, 500, {
                error: `MongoDB đã lưu dữ liệu nhưng không tạo được file backup: ${error.message}`,
                databaseSaved: true
            });
            return;
        }
        sendJson(response, 200, {
            activeMonthKey: state.activeMonthKey,
            monthCount: Object.keys(state.monthDatasets).length,
            totalVesselCount: monthEntries.reduce((total, [, data]) => total + data.vessels.length, 0),
            updatedAt: confirmed.updatedAt,
            backupFile: path.basename(databaseBackupPath),
            backupUpdatedAt
        });
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

    if (request.method === 'GET' && url.pathname === '/api/datasets') {
        const items = await datasets.find({}, {
            projection: { _id: 1, updatedAt: 1, vesselCount: 1 }
        }).sort({ _id: 1 }).toArray();
        sendJson(response, 200, {
            datasets: items.map(item => ({
                key: item._id,
                updatedAt: item.updatedAt,
                vesselCount: item.vesselCount
            }))
        });
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
            const item = await datasets.findOne({ _id: key });
            if (!item) {
                sendJson(response, 404, { error: 'Dataset was not found.' });
                return;
            }
            sendJson(response, 200, {
                key: item._id,
                updatedAt: item.updatedAt,
                data: item.data
            });
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
            await datasets.replaceOne(
                { _id: key },
                { _id: key, data, vesselCount: data.vessels.length, updatedAt: new Date() },
                { upsert: true }
            );
            sendJson(response, 200, { key, vesselCount: data.vessels.length });
            return;
        }

        if (request.method === 'DELETE') {
            const result = await datasets.deleteOne({ _id: key });
            if (result.deletedCount === 0) {
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
    await mongoClient.connect();
    const database = mongoClient.db(databaseName);
    datasets = database.collection('datasets');
    applicationStates = database.collection('applicationState');

    const server = http.createServer((request, response) => {
        handleRequest(request, response).catch(error => {
            console.error(`API request failed: ${error.message}`);
            if (response.headersSent || response.destroyed) return;
            sendJson(response, error.statusCode || 500, {
                error: error.statusCode ? error.message : 'The request could not be completed.'
            });
        });
    });

    server.listen(port, host, () => {
        console.log(`Maritime statistics API listening at http://${host}:${port}`);
        console.log(`MongoDB database: ${databaseName}`);
    });

    const shutdown = () => {
        server.close(async () => {
            await mongoClient.close();
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(async error => {
    console.error(`Could not start the MongoDB API: ${error.message}`);
    await mongoClient.close();
    process.exit(1);
});
