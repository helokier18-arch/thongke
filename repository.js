'use strict';

const { MongoClient } = require('mongodb');
const { summarizeByArea } = require('./summary-report.js');

const databaseName = process.env.MONGODB_DB || 'maritime_statistics';
let client;
let connecting;

async function getDatabase() {
    const uri = String(process.env.MONGODB_URI || '').trim();
    if (!uri) {
        throw new Error('MONGODB_URI is not configured. Set it in the service environment.');
    }
    if (connecting) return connecting;

    client = new MongoClient(uri, {
        appName: 'maritime-vessel-statistics',
        serverSelectionTimeoutMS: 10000
    });
    connecting = client.connect()
        .then(() => client.db(databaseName))
        .catch(async () => {
            connecting = null;
            const failedClient = client;
            client = null;
            await failedClient.close().catch(() => {});
            throw new Error('MongoDB connection failed. Check MONGODB_URI, MONGODB_DB and Atlas Network Access.');
        });
    return connecting;
}

async function collection(name) {
    const db = await getDatabase();
    return db.collection(name);
}

async function getStateDocument() {
    const states = await collection('applicationState');
    return states.findOne({}, { sort: { updatedAt: -1 } });
}

async function getState() {
    const document = await getStateDocument();
    return {
        state: document?.state || null,
        updatedAt: document?.updatedAt || null
    };
}

async function getStateMeta() {
    const saved = await getState();
    return {
        stateExists: Boolean(saved.state),
        activeMonthKey: saved.state?.activeMonthKey || '',
        updatedAt: saved.updatedAt
    };
}

async function saveApplicationState(state) {
    const states = await collection('applicationState');
    const datasets = await collection('datasets');
    const current = await states.findOne({}, { projection: { _id: 1 } });
    const updatedAt = new Date();
    const filter = current ? { _id: current._id } : { _id: 'applicationState' };

    await states.updateOne(
        filter,
        { $set: { state, updatedAt } },
        { upsert: true }
    );

    const entries = Object.entries(state.monthDatasets || {});
    if (entries.length) {
        await datasets.bulkWrite(entries.map(([key, data]) => ({
            updateOne: {
                filter: { _id: key },
                update: { $set: { data, updatedAt } },
                upsert: true
            }
        })), { ordered: true });
    }

    return {
        updatedAt: updatedAt.toISOString(),
        monthCount: entries.length
    };
}

async function listVessels(area, monthKey = null) {
    const saved = await getState();
    const datasets = saved.state?.monthDatasets || {};
    const selected = monthKey
        ? [[monthKey, datasets[monthKey]]]
        : Object.entries(datasets);
    const vessels = [];

    for (const [key, dataset] of selected) {
        for (const vessel of dataset?.vessels || []) {
            if (area === 'Tổng hợp' || vessel.khuVuc === area) {
                vessels.push({ ...vessel, monthKey: key });
            }
        }
    }
    return vessels;
}

async function getSummaryRows(period) {
    const datasets = await collection('datasets');
    const documents = await datasets.find(
        { _id: { $in: period.months } },
        { projection: { _id: 1, 'data.vessels': 1 } }
    ).toArray();
    const vessels = documents.flatMap(document =>
        (document.data?.vessels || []).map(vessel => ({
            ...vessel,
            monthKey: document._id
        }))
    );
    return {
        rows: summarizeByArea(vessels),
        dataMonths: documents.map(document => document._id).sort()
    };
}

async function getDataset(key) {
    const datasets = await collection('datasets');
    const document = await datasets.findOne({ _id: key });
    if (!document) return null;
    return {
        key: document._id,
        data: document.data || {},
        updatedAt: document.updatedAt || null
    };
}

async function listDatasets() {
    const datasets = await collection('datasets');
    const documents = await datasets.find(
        {},
        { projection: { _id: 1, updatedAt: 1, 'data.vessels': 1 } }
    ).toArray();
    return documents.map(document => ({
        key: document._id,
        updatedAt: document.updatedAt || null,
        vesselCount: Array.isArray(document.data?.vessels)
            ? document.data.vessels.length
            : 0
    }));
}

async function saveDataset(key, data) {
    const datasets = await collection('datasets');
    await datasets.updateOne(
        { _id: key },
        { $set: { data, updatedAt: new Date() } },
        { upsert: true }
    );
}

async function deleteDataset(key) {
    const datasets = await collection('datasets');
    const result = await datasets.deleteOne({ _id: key });
    return result.deletedCount > 0;
}

const pool = {
    async query(statement) {
        if (String(statement).trim().toUpperCase() !== 'SELECT 1') {
            throw new Error('Unsupported health-check query.');
        }
        const db = await getDatabase();
        await db.command({ ping: 1 });
    },
    async end() {
        if (!client) return;
        const closingClient = client;
        client = null;
        connecting = null;
        await closingClient.close();
    }
};

module.exports = {
    pool,
    getState,
    getStateMeta,
    saveApplicationState,
    listVessels,
    getSummaryRows,
    getDataset,
    listDatasets,
    saveDataset,
    deleteDataset
};
