'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { AREA_NAMES } = require('../regional-areas.js');
const repository = require('../repository.js');

const projectRoot = path.resolve(__dirname, '..');
const errorsPath = path.join(projectRoot, 'migration-errors.log');
const topNumericFields = [
    ['id', 'legacyId'],
    ['grt', 'grt'],
    ['dwt', 'dwt'],
    ['length', 'length'],
    ['draft', 'draft'],
    ['clearanceHeight', 'clearanceHeight'],
    ['cargoAmount', 'cargoAmount'],
    ['cargoAmountIn', 'cargoAmountIn'],
    ['cargoAmountOut', 'cargoAmountOut'],
    ['sourceRow', 'sourceRow'],
    ['monthlySourceRow', 'monthlySourceRow'],
    ['sourceRouteCodesImported', 'sourceRouteCodesImported']
];
const breakdownFields = [
    'cargoInTons',
    'cargoOutTons',
    'containerTeus',
    'containerTeusIn',
    'containerTeusOut',
    'containerTons',
    'containerTonsIn',
    'containerTonsOut',
    'domesticTons',
    'dryTons',
    'dryTonsIn',
    'dryTonsOut',
    'exportTons',
    'importTons',
    'liquidTons',
    'liquidTonsIn',
    'liquidTonsOut',
    'passengersIn',
    'passengersOut',
    'transitDirectTons',
    'transitLoadedTons',
    'transshipmentTons'
];
const comparisonFields = [
    ...topNumericFields.map(([, alias]) => alias),
    ...breakdownFields
];

function parseArguments(args) {
    const options = {
        dryRun: args.includes('--dry-run'),
        sourceJson: '',
        datasetsJson: '',
        applicationStateJson: ''
    };
    for (let index = 0; index < args.length; index++) {
        if (args[index] === '--source-json') options.sourceJson = args[++index] || '';
        if (args[index] === '--datasets-json') options.datasetsJson = args[++index] || '';
        if (args[index] === '--application-state-json') options.applicationStateJson = args[++index] || '';
    }
    if (options.sourceJson && (options.datasetsJson || options.applicationStateJson)) {
        throw new Error('Use either --source-json or the two mongoexport files, not both.');
    }
    if (Boolean(options.datasetsJson) !== Boolean(options.applicationStateJson)) {
        throw new Error('Provide both --datasets-json and --application-state-json.');
    }
    return options;
}

function normalizeArea(value, vessel = {}) {
    try {
        return repository.normalizeArea(value, vessel);
    } catch {
        return '';
    }
}

function sourceStats() {
    return new Map(AREA_NAMES.map(area => [
        area,
        { vesselCount: 0, sums: Object.fromEntries(comparisonFields.map(field => [field, 0])) }
    ]));
}

function numericValue(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function addSourceVessel(stats, vessel) {
    const area = normalizeArea(vessel?.khuVuc, vessel);
    if (!area) return;
    const entry = stats.get(area);
    entry.vesselCount++;
    for (const [sourceField, targetField] of topNumericFields) {
        entry.sums[targetField] += numericValue(vessel[sourceField]);
    }
    for (const field of breakdownFields) {
        entry.sums[field] += numericValue(vessel.cargoBreakdown?.[field]);
    }
}

function summarizeAreas(stats) {
    return AREA_NAMES.map(khuVuc => ({
        khuVuc,
        vesselCount: stats.get(khuVuc).vesselCount
    }));
}

function compareReconciliation(source, targetRows) {
    const targetByArea = new Map(targetRows.map(row => [row.khuVuc, row]));
    return AREA_NAMES.map(khuVuc => {
        const sourceArea = source.get(khuVuc);
        const target = targetByArea.get(khuVuc) || {};
        const numericMismatches = comparisonFields.filter(field => {
            const sourceValue = Number(sourceArea.sums[field]) || 0;
            const targetValue = Number(target[field]) || 0;
            return Math.abs(sourceValue - targetValue) > 0.001;
        });
        return {
            khuVuc,
            sourceCount: sourceArea.vesselCount,
            mysqlCount: Number(target.vesselCount) || 0,
            countMatches: sourceArea.vesselCount === (Number(target.vesselCount) || 0),
            numericMismatches
        };
    });
}

function isIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function vesselValidationReason(vessel) {
    if (!normalizeArea(vessel?.khuVuc, vessel)) return 'Missing or invalid fixed khuVuc and port area.';
    if (vessel?.id === undefined || vessel.id === null || vessel.id === '' ||
        !Number.isSafeInteger(Number(vessel.id)) || Number(vessel.id) < 0) {
        return 'Missing or non-integer legacy vessel id.';
    }
    if (!isIsoDate(vessel?.dateIn)) return 'dateIn must use a valid YYYY-MM-DD date.';
    return '';
}

function logError(errors, error) {
    errors.push({
        at: new Date().toISOString(),
        collection: error.collection || '',
        sourceKey: error.sourceKey || '',
        row: error.row ?? null,
        reason: String(error.reason || 'Unknown migration error').slice(0, 1000)
    });
}

async function readJsonLines(filePath) {
    const text = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '').trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.collections?.datasets)) return parsed.collections.datasets;
        return [parsed];
    } catch (arrayParseError) {
        return text.split(/\r?\n/)
            .filter(line => line.trim())
            .map((line, index) => {
                try {
                    return JSON.parse(line);
                } catch {
                    throw new Error(`Invalid JSON on line ${index + 1} of ${path.basename(filePath)}.`);
                }
            });
    }
}

async function loadJsonSource(options) {
    if (options.sourceJson) {
        const filePath = path.resolve(options.sourceJson);
        const text = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
        const backup = JSON.parse(text);
        if (backup.format === 'maritime-statistics-mongodb-backup' && backup.collections) {
            return {
                datasets: backup.collections.datasets || [],
                applicationStates: backup.collections.applicationState || []
            };
        }
        const docs = Array.isArray(backup) ? backup : [backup];
        return {
            datasets: docs.filter(doc => doc && doc.data && Array.isArray(doc.data.vessels)),
            applicationStates: docs.filter(doc => doc && doc.state && doc.state.monthDatasets)
        };
    }
    return {
        datasets: await readJsonLines(path.resolve(options.datasetsJson)),
        applicationStates: await readJsonLines(path.resolve(options.applicationStateJson))
    };
}

async function withMongoSource(callback) {
    const uri = process.env.MIGRATION_MONGODB_URI || process.env.MONGODB_URI;
    if (!uri) {
        throw new Error('Set MIGRATION_MONGODB_URI or MONGODB_URI, or pass Mongo export JSON files.');
    }
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    try {
        await client.connect();
        const database = client.db(process.env.MONGODB_DB || 'maritime_statistics');
        await callback({
            forEachDataset: async handler => {
                const cursor = database.collection('datasets').find({}).batchSize(50);
                for await (const document of cursor) await handler(document);
            },
            forEachApplicationState: async handler => {
                const cursor = database.collection('applicationState').find({}).batchSize(10);
                for await (const document of cursor) await handler(document);
            }
        });
    } catch (error) {
        if (error.message.includes('Set MIGRATION_MONGODB_URI')) throw error;
        throw new Error('Could not read the MongoDB source. Retry with --source-json or both mongoexport JSON files.');
    } finally {
        await client.close();
    }
}

function jsonSourceAdapter(source) {
    return {
        forEachDataset: async handler => {
            for (const document of source.datasets) await handler(document);
        },
        forEachApplicationState: async handler => {
            for (const document of source.applicationStates) await handler(document);
        }
    };
}

async function run() {
    const options = parseArguments(process.argv.slice(2));
    const errors = [];
    const stats = sourceStats();
    const report = {
        dryRun: options.dryRun,
        applicationStateRead: 0,
        datasetsRead: 0,
        vesselsRead: 0,
        inserted: 0,
        updated: 0,
        skipped: 0
    };

    await repository.pool.query('SELECT 1');
    await repository.pool.query('SELECT COUNT(*) FROM application_state');
    await repository.pool.query('SELECT COUNT(*) FROM datasets');
    await repository.pool.query('SELECT COUNT(*) FROM vessels');

    const processSource = async source => {
        await source.forEachApplicationState(async document => {
            report.applicationStateRead++;
            if (!options.dryRun) {
                try {
                    const invalidRows = [];
                    await repository.saveMigratedApplicationState(document, invalidRows);
                    report.skipped += invalidRows.length;
                    invalidRows.forEach(item => logError(errors, {
                        collection: 'applicationState',
                        sourceKey: document?._id,
                        row: `${item.monthKey}:${item.index + 1}`,
                        reason: item.reason
                    }));
                } catch (error) {
                    logError(errors, {
                        collection: 'applicationState',
                        sourceKey: document?._id,
                        reason: error.message
                    });
                    report.skipped++;
                }
            }
        });

        await source.forEachDataset(async document => {
            report.datasetsRead++;
            const sourceKey = String(document?._id ?? '');
            const vessels = Array.isArray(document?.data?.vessels) ? document.data.vessels : [];
            report.vesselsRead += vessels.length;
            vessels.forEach((vessel, index) => {
                if (vesselValidationReason(vessel)) return;
                addSourceVessel(stats, vessel);
            });
            if (options.dryRun) {
                vessels.forEach((vessel, index) => {
                    const reason = vesselValidationReason(vessel);
                    if (!reason) return;
                    logError(errors, { collection: 'datasets', sourceKey, row: index + 1, reason });
                    report.skipped++;
                });
                return;
            }
            try {
                const invalidRows = [];
                const result = await repository.saveMigratedDataset(document, invalidRows);
                report.inserted += result.inserted;
                report.updated += result.updated;
                report.skipped += result.skipped;
                invalidRows.forEach(item => logError(errors, {
                    collection: 'datasets',
                    sourceKey,
                    row: item.index + 1,
                    reason: item.reason
                }));
            } catch (error) {
                logError(errors, {
                    collection: 'datasets',
                    sourceKey,
                    reason: error.message
                });
                report.skipped += vessels.length || 1;
            }
        });
    };

    if (options.sourceJson || options.datasetsJson) {
        await processSource(jsonSourceAdapter(await loadJsonSource(options)));
    } else {
        await withMongoSource(processSource);
    }

    report.sourceVesselsByArea = summarizeAreas(stats);
    report.errors = errors.length;
    if (errors.length) {
        await fs.appendFile(errorsPath, `${errors.map(error => JSON.stringify(error)).join('\n')}\n`, 'utf8');
        report.errorLog = path.basename(errorsPath);
    }

    if (!options.dryRun) {
        const targetRows = await repository.reconcileByArea();
        report.reconciliation = compareReconciliation(stats, targetRows);
        report.reconciliationMatches = report.reconciliation.every(area =>
            area.countMatches && area.numericMismatches.length === 0
        );
    }
    console.log(JSON.stringify(report, null, 2));
    if (errors.length || report.reconciliationMatches === false) process.exitCode = 1;
}

run()
    .catch(error => {
        console.error(`MongoDB-to-MySQL migration failed: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await repository.pool.end();
        } catch (error) {
            console.error(`Could not close the MySQL pool: ${error.message}`);
            process.exitCode = 1;
        }
    });
