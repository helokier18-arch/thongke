'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parseExcelVessels } = require('../server.js');

async function createWorkbook(rows) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Thống kê');
    rows.forEach(row => worksheet.addRow(row));
    return workbook.xlsx.writeBuffer();
}

test('Excel imports classify a loading berth even when the name omits its region', async () => {
    const file = await createWorkbook([
        ['Tên tàu', 'GRT', 'DWT', 'Quốc tịch', 'Ngày đến', 'Bến làm hàng'],
        ['Tàu kiểm thử', 100, 200, 'Việt Nam', '2026-01-01', 'HỢP THỊNH']
    ]);

    const result = await parseExcelVessels(file, 'auto');

    assert.deepEqual(result.errors, []);
    assert.equal(result.vessels.length, 1);
    assert.equal(result.vessels[0].khuVuc, 'Cửa Việt');
});

test('Excel import uses an explicit area only when the berth is not mapped', async () => {
    const file = await createWorkbook([
        ['Tên tàu', 'GRT', 'DWT', 'Quốc tịch', 'Ngày đến', 'Bến làm hàng', 'Khu vực'],
        ['Tàu kiểm thử 1', 100, 200, 'Việt Nam', '2026-01-01', 'Bến chưa có trong danh mục', 'Cửa Việt'],
        ['Tàu kiểm thử 2', 100, 200, 'Việt Nam', '2026-01-02', 'Bến cảng PTSC Hòn La', 'Cửa Việt'],
        ['Tàu kiểm thử 3', 100, 200, 'Việt Nam', '2026-01-03', 'Bến chưa rõ', '']
    ]);

    const result = await parseExcelVessels(file, 'auto');

    assert.deepEqual(result.vessels.map(vessel => vessel.khuVuc), ['Cửa Việt', 'Hòn La']);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].reason, /Không xác định được khu vực/);
});
