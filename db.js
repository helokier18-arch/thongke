'use strict';

require('dotenv').config();

const mysql = require('mysql2/promise');

const port = Number(process.env.DB_PORT || 3306);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_PORT must be a valid TCP port.');
}

const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'maritime_statistics',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    multipleStatements: false
});

async function withTransaction(operation) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const result = await operation(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            console.error(`MySQL transaction rollback failed: ${rollbackError.message}`);
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function ping() {
    await pool.query('SELECT 1');
}

async function close() {
    await pool.end();
}

module.exports = {
    pool,
    withTransaction,
    ping,
    close
};
