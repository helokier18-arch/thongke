function monthlyDateSerial(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return '';
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000 + 25569;
}

function monthlyRoute(record, direction) {
    if (record.movementType === 'island') return 'BRĐ';
    if (record.movementType === 'domestic') return 'NĐ';
    if (record.movementType === 'international') return direction === 'in' ? 'NC' : 'XC';
    return '';
}

function monthlyRouteFlag(record, direction) {
    const route = monthlyRoute(record, direction);
    if (route === 'NC' || route === 'XC') return 1;
    if (route === 'NĐ' || route === 'BRĐ') return 0;
    return '';
}

function classifyBerthCategory(value) {
    const normalizedCategory = String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .trim();
    if (normalizedCategory === 'CC' || /\bCAU CANG\b/.test(normalizedCategory)) return 'CC';
    if (normalizedCategory === 'BP' || /\bBEN PHAO\b/.test(normalizedCategory)) return 'BP';
    if (normalizedCategory === 'CT' || /\bKHU NEO\b|\bNEO DAU\b/.test(normalizedCategory)) return 'CT';
    return '';
}

function monthlySheetShipType(record) {
    const normalizeCode = value => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .replace(/[^a-z0-9]/gi, '')
        .toUpperCase();
    const grade = normalizeCode(record.inspectionGrade || record.inlandClass);
    const shipType = normalizeCode(record.shipType);
    if (['VRSB', 'SB'].includes(grade) ||
        ['VRSB', 'SB'].includes(shipType) ||
        String(record.movementType || '').trim().toLowerCase() === 'vr-sb') {
        return 'SB';
    }
    return record.shipType;
}

function monthlyColumnName(columnIndex) {
    let column = columnIndex + 1;
    let name = '';
    while (column > 0) {
        const remainder = (column - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        column = Math.floor((column - 1) / 26);
    }
    return name;
}

function monthlyCellAddress(rowIndex, columnIndex) {
    return `${monthlyColumnName(columnIndex)}${rowIndex + 1}`;
}

function calculateMonthlySheetAssignments(sheetView, records = []) {
    if (!sheetView || !Array.isArray(sheetView.rows)) return null;
    if (sheetView.borrowedSummaryTemplate) {
        const routeDomesticTotal = sheetView.rows[326 - sheetView.startRow - 1]
            ?.find(cell => cell[0] === 10);
        if (routeDomesticTotal?.[3]) {
            routeDomesticTotal[3] = routeDomesticTotal[3].replace(/\s*-\s*\$?B\$?154\b/, '');
        }
    }
    const activeIds = new Set(records.map(record => String(record.id)));
    const assignments = new Map();
    const usedRows = new Set();
    (sheetView.recordRows || []).forEach(([id, row]) => {
        if (!activeIds.has(String(id)) || !Number.isInteger(row) || usedRows.has(row)) return;
        assignments.set(String(id), row);
        usedRows.add(row);
    });
    const firstDataRow = 5;
    const borrowedSummaryTemplate = sheetView.borrowedSummaryTemplate;
    const summaryHeaderPattern = /^(SỐ LƯỢT|TỔNG SỐ LƯỢT|HÀNG H(?:ÓA|OÁ)|TỔNG HÀNG H(?:ÓA|OÁ)|TỔNG SẢN LƯỢNG|SẢN LƯỢNG|HÀNH KHÁCH|TỔNG HÀNH KHÁCH|LƯỢT TÀU, HÀNG)/i;
    const firstSummaryRowIndex = borrowedSummaryTemplate
        ? -1
        : sheetView.rows.findIndex((row, index) =>
            sheetView.startRow + index >= 97 &&
            row.some(([column, value]) =>
                column <= 11 && summaryHeaderPattern.test(String(value || '').trim())
            )
        );
    const lastOriginalDataRow = firstSummaryRowIndex >= 0
        ? Math.max(96, sheetView.startRow + firstSummaryRowIndex - 4)
        : 96;
    const insertionRow = lastOriginalDataRow + 1;
    if (borrowedSummaryTemplate) {
        assignments.clear();
        usedRows.clear();
        const originalDataCapacity = lastOriginalDataRow - firstDataRow + 1;
        records.forEach((record, index) => {
            const row = index < originalDataCapacity
                ? firstDataRow + index
                : lastOriginalDataRow + 1 + index - originalDataCapacity;
            assignments.set(String(record.id), row);
            usedRows.add(row);
        });
    }
    let nextOverflowRow = Math.max(
        insertionRow,
        ...[...usedRows].filter(row => row > lastOriginalDataRow).map(row => row + 1)
    );
    records.forEach(record => {
        const id = String(record.id);
        if (assignments.has(id)) return;
        let row = firstDataRow;
        while (row <= lastOriginalDataRow && usedRows.has(row)) row++;
        if (row > lastOriginalDataRow) {
            row = nextOverflowRow++;
        }
        assignments.set(id, row);
        usedRows.add(row);
    });
    sheetView.recordRows = [...assignments.entries()]
        .map(([id, row]) => [id, row]);
    return {
        assignments,
        overflow: Math.max(0, ...assignments.values()) > lastOriginalDataRow
            ? Math.max(...assignments.values()) - lastOriginalDataRow
            : 0,
        formulaEndRow: Math.max(lastOriginalDataRow + 1, ...[...assignments.values()].map(row => row + 1)),
        lastOriginalDataRow,
        insertionRow
    };
}

function normalizeMonthlyConditionalRanges(formula) {
    const functionMatches = [...formula.matchAll(/\b(SUMIFS|COUNTIFS)\s*\(/gi)];
    let normalized = formula;

    function parseFunctionArguments(openingIndex) {
        const args = [];
        let argumentStart = openingIndex + 1;
        let depth = 1;
        let braceDepth = 0;
        let inString = false;
        for (let index = openingIndex + 1; index < normalized.length; index++) {
            const character = normalized[index];
            if (character === '"') {
                if (inString && normalized[index + 1] === '"') {
                    index++;
                    continue;
                }
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (character === '(') depth++;
            else if (character === ')') {
                depth--;
                if (depth === 0) {
                    args.push(normalized.slice(argumentStart, index).trim());
                    return { args, closingIndex: index };
                }
            } else if (character === '{') braceDepth++;
            else if (character === '}') braceDepth--;
            else if (character === ',' && depth === 1 && braceDepth === 0) {
                args.push(normalized.slice(argumentStart, index).trim());
                argumentStart = index + 1;
            }
        }
        throw new Error(`Công thức SUMIFS/COUNTIFS không hợp lệ: ${formula}`);
    }

    function parseRange(range) {
        const match = range.match(/^((?:'[^']+'|[A-Z0-9_.]+)!)?(\$?)([A-Z]{1,3})(\$?)(\d+):(\$?)([A-Z]{1,3})(\$?)(\d+)$/i);
        if (!match) return null;
        const startColumn = match[3].toUpperCase();
        const endColumn = match[7].toUpperCase();
        const columnNumber = column => [...column].reduce(
            (number, character) => number * 26 + character.charCodeAt(0) - 64,
            0
        );
        return {
            prefix: match[1] || '',
            startColumn,
            endColumn,
            startRow: Number(match[5]),
            endRow: Number(match[9]),
            width: Math.abs(columnNumber(endColumn) - columnNumber(startColumn)) + 1,
            startColumnAbsolute: match[2],
            startRowAbsolute: match[4],
            endColumnAbsolute: match[6],
            endRowAbsolute: match[8]
        };
    }

    for (const match of functionMatches.reverse()) {
        const openingIndex = match.index + match[0].lastIndexOf('(');
        const { args, closingIndex } = parseFunctionArguments(openingIndex);
        const rangeIndexes = match[1].toUpperCase() === 'SUMIFS'
            ? [0, ...args.map((_, index) => index).filter(index => index % 2 === 1)]
            : args.map((_, index) => index).filter(index => index % 2 === 0);
        const anchorIndex = rangeIndexes[0];
        const anchor = parseRange(args[anchorIndex] || '');
        if (!anchor) continue;

        rangeIndexes.slice(1).forEach(index => {
            const range = parseRange(args[index] || '');
            if (!range) return;
            const rowCount = value => Math.abs(value.endRow - value.startRow) + 1;
            if (range.width !== anchor.width) {
                throw new Error(`Các vùng trong ${match[1].toUpperCase()} không cùng kích thước: ${formula}`);
            }
            if (rowCount(range) === rowCount(anchor)) return;
            args[index] = `${range.prefix}${range.startColumnAbsolute}${range.startColumn}${range.startRowAbsolute}${anchor.startRow}:` +
                `${range.endColumnAbsolute}${range.endColumn}${range.endRowAbsolute}${anchor.endRow}`;
        });

        normalized = normalized.slice(0, match.index) +
            `${match[1]}(${args.join(',')})` +
            normalized.slice(closingIndex + 1);
    }
    return normalized;
}

function shiftMonthlyFormula(formula, overflow, sourceRow, targetRow, formulaEndRow, insertionRow) {
    let shifted = normalizeMonthlyConditionalRanges(formula).replace(/(\$?[A-Z]{1,3}\$?)(\d+)/g, (reference, column, rowText) => {
        const row = Number(rowText);
        if (sourceRow !== null && row === sourceRow) return `${column}${targetRow}`;
        return `${column}${row >= insertionRow + 1 ? row + overflow : row}`;
    });
    const dataEndRow = insertionRow;
    const dataRangeEnd = new RegExp(`(\\$?[A-Z]{1,3}\\$?6:\\$?[A-Z]{1,3}\\$?)${dataEndRow}\\b`, 'g');
    shifted = shifted.replace(dataRangeEnd, `$1${formulaEndRow}`);
    return shifted;
}

function calculateYearToDate(previousCumulative, currentMonthValue) {
    const previous = previousCumulative === null || previousCumulative === undefined || previousCumulative === ''
        ? null
        : Number(previousCumulative);
    const current = currentMonthValue === null || currentMonthValue === undefined || currentMonthValue === ''
        ? null
        : Number(currentMonthValue);
    if (previous === null || current === null || !Number.isFinite(previous) || !Number.isFinite(current)) {
        return null;
    }
    return previous + current;
}

function calculateReportCumulative(previousCumulative, currentMonthValue) {
    const previous = Number(previousCumulative);
    const current = Number(currentMonthValue);
    return (Number.isFinite(previous) ? previous : 0) +
        (Number.isFinite(current) ? current : 0);
}

function calculateImportedReportCumulative({
    monthDatasets,
    sheetName,
    row,
    monthColumn,
    cumulativeColumn,
    throughMonth,
    reportYear,
    currentPeriodMonth,
    currentMonthValue
}) {
    if (!monthDatasets || !Number.isInteger(reportYear) ||
        !Number.isInteger(throughMonth) || throughMonth < 0 || throughMonth > 12) {
        return null;
    }

    let cumulative = 0;
    for (let month = 1; month <= throughMonth; month++) {
        let monthValue;
        if (reportYear === currentPeriodMonth?.year && month === currentPeriodMonth.month) {
            monthValue = currentMonthValue;
        } else {
            const monthKey = `${reportYear}-${String(month).padStart(2, '0')}`;
            const cells = monthDatasets[monthKey]?.reportFormulaSheets?.[sheetName]?.cells;
            const importedMonthValue = cells?.[`${monthColumn}${row}`]?.value;
            monthValue = importedMonthValue === null || importedMonthValue === undefined || importedMonthValue === ''
                ? null
                : Number(importedMonthValue);
            if (!Number.isFinite(monthValue)) {
                const importedCumulative = Number(cells?.[`${cumulativeColumn}${row}`]?.value);
                monthValue = Number.isFinite(importedCumulative) && importedCumulative >= cumulative
                    ? importedCumulative - cumulative
                    : null;
            }
        }
        if (monthValue === null || monthValue === undefined || !Number.isFinite(Number(monthValue))) {
            return null;
        }
        cumulative = calculateYearToDate(cumulative, Number(monthValue));
        if (cumulative === null) return null;
    }
    return cumulative;
}

function calculateMonthlySheet(sheetView, records, context = {}) {
    if (!sheetView || !Array.isArray(sheetView.rows) || !sheetView.rows.some(row =>
        row.some(cell => cell[3])
    )) {
        return null;
    }
    const assignmentState = context.getMonthlySheetAssignments(sheetView, records);
    if (!assignmentState) {
        throw new Error('Không thể xác định các dòng dữ liệu của bảng màu tháng.');
    }
    const { assignments, overflow, formulaEndRow, lastOriginalDataRow, insertionRow } = assignmentState;
    const initialRows = new Map((sheetView.initialRecordRows || []).map(([id, row]) => [String(id), row]));
    const originalRecords = new Map((context.reportBaseline?.records || []).map(record => [String(record.id), record]));
    const cells = new Map();
    const formulas = new Map();
    const maxColumn = sheetView.startColumn + sheetView.columnCount - 1;
    const cellKey = (row, column) => `${row},${column}`;
    const loadCells = (row, entries, sourceRow, targetRow, isTemplate = false) => {
        entries.forEach(([column, value, background, formula, numberFormat]) => {
            const shiftedFormula = formula
                ? shiftMonthlyFormula(formula, overflow, isTemplate ? sourceRow + 1 : null, targetRow + 1, formulaEndRow, insertionRow)
                : '';
            cells.set(cellKey(row, column), {
                value: isTemplate ? '' : value,
                background,
                formula: shiftedFormula,
                numberFormat
            });
            if (shiftedFormula) formulas.set(cellKey(row, column), shiftedFormula);
        });
    };
    const sourceRowEntries = row => {
        const entries = sheetView.rows[row - sheetView.startRow] || [];
        return entries.map(([column, value, background, formula, numberFormat]) => [
            column,
            value,
            background,
            formula || '',
            numberFormat
        ]);
    };
    const dataStartRow = 5;
    const dataEndRow = lastOriginalDataRow;
    const reportPeriod = String(context.reportPeriod || '')
        .match(/^(\d{1,2})\/(\d{4})$/);
    const reportMonth = reportPeriod ? Number(reportPeriod[1]) : null;
    const reportYear = reportPeriod ? Number(reportPeriod[2]) : null;
    const activeByRow = new Map();
    records.forEach(record => {
        const row = assignments.get(String(record.id));
        if (row !== undefined) activeByRow.set(row, record);
    });

    const liveInputColumns = new Set([1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 32, 33, 34, 35]);
    for (let row = sheetView.startRow; row < sheetView.startRow + sheetView.rowCount + overflow; row++) {
        const isInsertedRow = row >= insertionRow && row < insertionRow + overflow;
        const sourceRow = isInsertedRow ? null : row >= insertionRow + overflow ? row - overflow : row;
        const assignmentRow = isInsertedRow ? row : sourceRow;
        const isDataRow = isInsertedRow || sourceRow >= dataStartRow && sourceRow <= dataEndRow;
        const displayRow = row;
        if (!isDataRow) {
            loadCells(displayRow, sourceRowEntries(sourceRow), null, displayRow + 1);
            continue;
        }

        const record = activeByRow.get(assignmentRow);
        if (!record) {
            const blanked = sourceRowEntries(sourceRow ?? dataStartRow).map(([column, value, background, formula, numberFormat]) =>
                [column, liveInputColumns.has(column) ? '' : value, background, formula, numberFormat]
            );
            loadCells(displayRow, blanked, null, displayRow + 1);
            continue;
        }
        const originalRecordRow = initialRows.get(String(record.id));
        const isOriginalRecordRow = !isInsertedRow && originalRecordRow === sourceRow;
        const originalRecord = originalRecords.get(String(record.id));
        const baseEntries = isOriginalRecordRow
            ? sourceRowEntries(sourceRow)
            : sourceRowEntries(dataStartRow).map(([column, value, background, formula, numberFormat]) => [
                column, '', background, formula, numberFormat
            ]);
        const rowCells = new Map(baseEntries.map(([column, value, background, formula, numberFormat]) => [
            column,
            { value, background, formula, numberFormat }
        ]));
        const put = (column, value) => {
            const existing = rowCells.get(column) || { background: '', formula: '', numberFormat: '' };
            rowCells.set(column, { ...existing, value: value ?? '' });
        };
        [
            [1, record.shipName],
            [2, Number(record.grt) || 0],
            [3, Number(record.dwt) || 0],
            [4, record.flag],
            [5, record.callSign],
            [6, Number(record.length) || 0],
            [8, Number(record.draft) || 0],
            [9, monthlySheetShipType(record)],
            [10, record.cargoType],
            [11, monthlyDateSerial(record.dateIn)],
            [12, monthlyDateSerial(record.dateOut)],
            [27, record.lastPort],
            [28, record.port],
            [29, record.nextPort],
            [30, record.imo],
            [32, record.agent]
        ].forEach(([column, value]) => put(column, value));
        const routeChanged = !isOriginalRecordRow || !originalRecord ||
            record.movementType !== originalRecord.movementType;
        if (routeChanged) {
            const importedRouteCodes = record.sourceRouteCodesImported === true;
            put(13, importedRouteCodes ? record.sourceRouteCode : monthlyRoute(record, 'in'));
            put(14, importedRouteCodes ? record.sourceRouteOutCode : monthlyRoute(record, 'out'));
            put(34, monthlyRouteFlag(record, 'in'));
            put(35, monthlyRouteFlag(record, 'out'));
        }
        if (!isOriginalRecordRow) {
            if (reportMonth !== null && reportYear !== null) {
                put(66, reportMonth);
                put(67, reportYear);
            }
        }
        const berthCategory = classifyBerthCategory(record.berthCategory);
        if (sheetView.borrowedSummaryTemplate || berthCategory) {
            put(15, berthCategory);
        }

        const cargoUnchanged = isOriginalRecordRow && originalRecord &&
            Number(originalRecord.cargoAmount) === Number(record.cargoAmount) &&
            JSON.stringify(originalRecord.cargoBreakdown || null) === JSON.stringify(record.cargoBreakdown || null);
        if (!cargoUnchanged) {
            const breakdown = record.cargoBreakdown || {};
            const cargoType = String(record.cargoType || '').toLocaleLowerCase('vi');
            const amount = Number(record.cargoAmount) || 0;
            const dry = breakdown.dryTons == null
                ? (cargoType.includes('lỏng') || cargoType.includes('dầu') || cargoType.includes('container') ? 0 : amount)
                : Number(breakdown.dryTons) || 0;
            const liquid = breakdown.liquidTons == null
                ? (cargoType.includes('lỏng') || cargoType.includes('dầu') ? amount : 0)
                : Number(breakdown.liquidTons) || 0;
            const container = breakdown.containerTons == null
                ? (cargoType.includes('container') ? amount : 0)
                : Number(breakdown.containerTons) || 0;
            const teus = Number(breakdown.containerTeus) || 0;
            const passengersIn = Number(breakdown.passengersIn) || 0;
            const passengersOut = Number(breakdown.passengersOut) || 0;
            const inbound = Boolean(record.dateIn);
            const directionalBreakdown = ['dryTonsIn', 'dryTonsOut', 'liquidTonsIn', 'liquidTonsOut',
                'containerTonsIn', 'containerTonsOut', 'containerTeusIn', 'containerTeusOut']
                .some(key => breakdown[key] !== null && breakdown[key] !== undefined && breakdown[key] !== '');
            put(16, directionalBreakdown ? Number(breakdown.dryTonsIn) || 0 : inbound ? dry : 0);
            put(17, directionalBreakdown ? Number(breakdown.dryTonsOut) || 0 : inbound ? 0 : dry);
            put(18, directionalBreakdown ? Number(breakdown.liquidTonsIn) || 0 : inbound ? liquid : 0);
            put(19, directionalBreakdown ? Number(breakdown.liquidTonsOut) || 0 : inbound ? 0 : liquid);
            put(20, directionalBreakdown ? Number(breakdown.containerTonsIn) || 0 : inbound ? container : 0);
            put(21, directionalBreakdown ? Number(breakdown.containerTeusIn) || 0 : inbound ? teus : 0);
            put(22, directionalBreakdown ? Number(breakdown.containerTonsOut) || 0 : inbound ? 0 : container);
            put(23, directionalBreakdown ? Number(breakdown.containerTeusOut) || 0 : inbound ? 0 : teus);
            put(24, inbound ? passengersIn : 0);
            put(25, inbound ? 0 : passengersOut);
        }
        const entries = [...rowCells.entries()].map(([column, cell]) => [
            column, cell.value, cell.background, cell.formula, cell.numberFormat
        ]);
        const rowTemplate = !isOriginalRecordRow;
        entries.forEach(([column, value, background, formula, numberFormat]) => {
            let shiftedFormula = formula
                ? shiftMonthlyFormula(formula, overflow, rowTemplate ? dataStartRow + 1 : null, displayRow + 1, formulaEndRow, insertionRow)
                : '';
            if (sheetView.countEachRecordOnce && column === 37 && shiftedFormula) {
                shiftedFormula = `IF(AK${displayRow + 1}=0,${shiftedFormula},0)`;
            }
            cells.set(cellKey(displayRow, column), { value, background, formula: shiftedFormula, numberFormat });
            if (shiftedFormula) formulas.set(cellKey(displayRow, column), shiftedFormula);
        });
        for (let column = 0; column <= maxColumn; column++) {
            if (!cells.has(cellKey(displayRow, column))) {
                cells.set(cellKey(displayRow, column), { value: '', background: '', formula: '', numberFormat: '' });
            }
        }
    }

    const visiting = new Set();
    const formulaErrors = new Set();
    const tokenize = formula => {
        const tokens = formula.match(/"(?:[^"]|"")*"|#[A-Z0-9/!?]+|\$?[A-Z]{1,3}\$?\d+|\d+(?:\.\d+)?(?:E[+-]?\d+)?|<>|>=|<=|[A-Z_][A-Z0-9_.]*|[()+\-*\/&,=:<>{}]/gi);
        if (!tokens || tokens.join('').replace(/\s/g, '') !== formula.replace(/\s/g, '')) {
            throw new Error(`Công thức không hỗ trợ: ${formula}`);
        }
        return tokens;
    };
    const columnIndex = name => {
        let column = 0;
        for (const character of name.replace(/\$/g, '').toUpperCase()) {
            column = column * 26 + character.charCodeAt(0) - 64;
        }
        return column - 1;
    };
    const cellReference = reference => {
        const match = reference.replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/i);
        if (!match) throw new Error(`Tham chiếu ô không hợp lệ: ${reference}`);
        return { column: columnIndex(match[1]), row: Number(match[2]) - 1 };
    };
    const evaluateCell = (row, column) => {
        if (sheetView.borrowedSummaryTemplate && sheetView.countEachRecordOnce) {
            if (column === 1 && row === 142 + overflow) return records.length;
            if (column === 1 && row === 224 + overflow) {
                return records.reduce((sum, record) => sum + (Number(record.cargoAmount) || 0), 0);
            }
        }
        const key = cellKey(row, column);
        if (!formulas.has(key)) return cells.get(key)?.value ?? '';
        if (visiting.has(key)) throw new Error(`Công thức vòng lặp tại ${key}`);
        if (memo.has(key)) return memo.get(key);
        visiting.add(key);
        let result;
        try {
            result = evaluateFormula(formulas.get(key));
        } catch (error) {
            const formula = formulas.get(key);
            if (!formulaErrors.has(formula)) {
                console.error(`Không thể tính công thức sheet tháng tại ${key}:`, error);
                formulaErrors.add(formula);
            }
            result = '#ERROR!';
        } finally {
            visiting.delete(key);
        }
        if (result === blankCellReference) result = 0;
        memo.set(key, result);
        return result;
    };
    const memo = new Map();
    const flatten = value => {
        if (Array.isArray(value)) return value.flatMap(flatten);
        if (value?.range) return value.range.flatMap(flatten);
        return [value];
    };
    const blankCellReference = Symbol('blankCellReference');
    const formulaText = value => value === blankCellReference ? '' : value ?? '';
    const truthy = value => value !== blankCellReference &&
        !(value === '' || value === null || value === undefined || value === 0 || value === false);
    const numeric = value => value === blankCellReference || value === '' || value === null || value === undefined
        ? 0
        : Number(value) || 0;
    const compare = (left, operator, right) => {
        left = formulaText(left);
        right = formulaText(right);
        const leftNumber = left === '' ? 0 : Number(left);
        const rightNumber = right === '' ? 0 : Number(right);
        const bothNumeric = left !== '' && right !== '' &&
            Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
        const a = bothNumeric ? leftNumber : String(left ?? '').toLocaleLowerCase('vi');
        const b = bothNumeric ? rightNumber : String(right ?? '').toLocaleLowerCase('vi');
        switch (operator) {
            case '=': return a === b;
            case '<>': return a !== b;
            case '>': return a > b;
            case '<': return a < b;
            case '>=': return a >= b;
            case '<=': return a <= b;
            default: throw new Error(`Toán tử so sánh không hỗ trợ: ${operator}`);
        }
    };
    const matchesCriteria = (value, criterion) => {
        value = formulaText(value);
        criterion = formulaText(criterion);
        const text = String(criterion ?? '');
        const match = text.match(/^(<>|>=|<=|>|<|=)(.*)$/);
        const operator = match?.[1] || '=';
        let expected = match ? match[2] : criterion;
        if (typeof expected === 'string' && expected.includes('*')) {
            const escaped = expected.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
            const matched = new RegExp(`^${escaped}$`, 'i').test(String(value ?? ''));
            return operator === '<>' ? !matched : matched;
        }
        if (expected === '') return operator === '<>' ? value !== '' && value !== null : value === '' || value === null;
        const asNumber = Number(expected);
        if (Number.isFinite(asNumber) && String(expected).trim() !== '') expected = asNumber;
        return compare(value, operator, expected);
    };
    const parseA1 = reference => {
        const { row, column } = cellReference(reference);
        const key = cellKey(row, column);
        const value = evaluateCell(row, column);
        return value === '' && !formulas.has(key) ? blankCellReference : value;
    };
    const evaluateFormula = formula => {
        const tokens = tokenize(String(formula || '').replace(/^=/, ''));
        let position = 0;
        const peek = () => tokens[position];
        const take = () => tokens[position++];
        const parseComparison = () => {
            let value = parseAdditive();
            while (['=', '<>', '>', '<', '>=', '<='].includes(peek())) {
                const operator = take();
                value = compare(value, operator, parseAdditive()) ? 1 : 0;
            }
            return value;
        };
        const parseAdditive = () => {
            let value = parseMultiplicative();
            while (peek() === '+' || peek() === '-' || peek() === '&') {
                const operator = take();
                const right = parseMultiplicative();
                value = operator === '+'
                    ? numeric(value) + numeric(right)
                    : operator === '-'
                        ? numeric(value) - numeric(right)
                        : `${formulaText(value)}${formulaText(right)}`;
            }
            return value;
        };
        const parseMultiplicative = () => {
            let value = parseUnary();
            while (peek() === '*' || peek() === '/') {
                const operator = take();
                const right = parseUnary();
                value = operator === '*' ? numeric(value) * numeric(right) : numeric(value) / numeric(right);
            }
            return value;
        };
        const parseUnary = () => {
            if (peek() === '+') {
                take();
                return numeric(parseUnary());
            }
            if (peek() === '-') {
                take();
                return -numeric(parseUnary());
            }
            return parsePrimary();
        };
        const parsePrimary = () => {
            const token = take();
            if (token === '(') {
                const value = parseComparison();
                if (take() !== ')') throw new Error(`Thiếu dấu đóng ngoặc trong ${formula}`);
                return value;
            }
            if (token === '{') {
                const values = [];
                if (peek() !== '}') {
                    do {
                        values.push(parseComparison());
                        if (peek() !== ',') break;
                        take();
                    } while (position < tokens.length);
                }
                if (take() !== '}') throw new Error(`Thiếu dấu đóng mảng trong ${formula}`);
                return values;
            }
            if (token?.startsWith('"')) return token.slice(1, -1).replace(/""/g, '"');
            if (token?.startsWith('#')) throw new Error(`Lỗi Excel ${token} trong công thức ${formula}`);
            if (/^\d/.test(token || '')) return Number(token);
            if (/^\$?[A-Z]{1,3}\$?\d+$/i.test(token || '')) {
                if (peek() === ':') {
                    take();
                    const end = take();
                    const startCell = cellReference(token);
                    const endCell = cellReference(end);
                    const values = [];
                    for (let row = Math.min(startCell.row, endCell.row); row <= Math.max(startCell.row, endCell.row); row++) {
                        for (let column = Math.min(startCell.column, endCell.column); column <= Math.max(startCell.column, endCell.column); column++) {
                            values.push(evaluateCell(row, column));
                        }
                    }
                    return { range: values };
                }
                return parseA1(token);
            }
            if (/^[A-Z_][A-Z0-9_.]*$/i.test(token || '') && peek() === '(') {
                take();
                const args = [];
                if (peek() !== ')') {
                    do {
                        args.push(parseComparison());
                        if (peek() !== ',') break;
                        take();
                    } while (position < tokens.length);
                }
                if (take() !== ')') throw new Error(`Thiếu dấu đóng ngoặc trong ${formula}`);
                const name = token.toUpperCase();
                if (name === 'IF') return truthy(args[0]) ? args[1] : args[2];
                if (name === 'AND') return args.every(truthy) ? 1 : 0;
                if (name === 'OR') return args.some(truthy) ? 1 : 0;
                if (name === 'DATE') {
                    const date = new Date(Date.UTC(numeric(args[0]), numeric(args[1]) - 1, numeric(args[2])));
                    return date.getTime() / 86400000 + 25569;
                }
                if (name === 'SUM') return flatten(args).reduce((sum, value) => sum + numeric(value), 0);
                if (name === 'SUMIFS') {
                    const sumRange = flatten(args[0]);
                    let total = 0;
                    for (let index = 0; index < sumRange.length; index++) {
                        let matchAll = true;
                        for (let criterionIndex = 1; criterionIndex + 1 < args.length; criterionIndex += 2) {
                            const criteriaRange = flatten(args[criterionIndex]);
                            const criteriaValues = Array.isArray(args[criterionIndex + 1])
                                ? args[criterionIndex + 1]
                                : [args[criterionIndex + 1]];
                            if (!criteriaValues.some(criterion => matchesCriteria(criteriaRange[index], criterion))) {
                                matchAll = false;
                                break;
                            }
                        }
                        if (matchAll) total += numeric(sumRange[index]);
                    }
                    return total;
                }
                if (name === 'CONCATENATE') return flatten(args).map(formulaText).join('');
                throw new Error(`Hàm Excel chưa hỗ trợ: ${name}`);
            }
            if (/^TRUE$/i.test(token || '')) return 1;
            if (/^FALSE$/i.test(token || '')) return 0;
            throw new Error(`Giá trị công thức không hỗ trợ: ${token}`);
        };
        const result = parseComparison();
        if (position !== tokens.length) throw new Error(`Phần công thức chưa xử lý: ${tokens.slice(position).join('')}`);
        return result;
    };
    const formattedRows = [];
    for (let row = sheetView.startRow; row < sheetView.startRow + sheetView.rowCount + overflow; row++) {
        const rowCells = [];
        for (let column = sheetView.startColumn; column <= maxColumn; column++) {
            const cell = cells.get(cellKey(row, column));
            if (!cell) continue;
            let value = cell.formula ? evaluateCell(row, column) : cell.value;
            const spreadsheet = globalThis.XLSX;
            if (typeof value === 'number' && cell.numberFormat && spreadsheet?.SSF) {
                value = spreadsheet.SSF.format(cell.numberFormat, value);
                const formatWithoutLiterals = cell.numberFormat.replace(/\[[^\]]*\]|"[^"]*"/g, '');
                if (!/[dmyhs]/i.test(formatWithoutLiterals)) {
                    value = String(value).replace(/,/g, '\u0000').replace(/\./g, ',').replace(/\u0000/g, '.');
                }
            } else if (typeof value === 'number') {
                value = value.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
            } else if (value === null || value === undefined) {
                value = '';
            } else {
                value = String(value);
            }
            if (value !== '' || cell.background || cell.formula) {
                rowCells.push([column, value, cell.background]);
            }
        }
        formattedRows.push(rowCells);
    }
    const merges = sheetView.merges.map(merge => ({
        ...merge,
        startRow: merge.startRow >= insertionRow ? merge.startRow + overflow : merge.startRow,
        endRow: merge.endRow >= insertionRow ? merge.endRow + overflow : merge.endRow
    }));
    const rowHeights = [
        ...sheetView.rowHeights.slice(0, insertionRow - sheetView.startRow),
        ...Array(overflow).fill(sheetView.rowHeights[insertionRow - 1 - sheetView.startRow] || 20),
        ...sheetView.rowHeights.slice(insertionRow - sheetView.startRow)
    ];
    const rawValues = {};
    const exportedFormulas = {};
    const numberFormats = {};
    for (const [key, cell] of cells) {
        const [rowText, columnText] = key.split(',');
        const row = Number(rowText);
        const column = Number(columnText);
        const address = monthlyCellAddress(row, column);
        rawValues[address] = cell.formula ? evaluateCell(row, column) : cell.value;
        numberFormats[address] = cell.numberFormat || '';
        if (cell.formula) exportedFormulas[address] = cell.formula;
    }
    return {
        rows: formattedRows,
        merges,
        rowHeights,
        rowCount: sheetView.rowCount + overflow,
        formulaErrors: formulaErrors.size,
        rawValues,
        formulas: exportedFormulas,
        numberFormats
    };
}

function calculateReportFormulaSheets(monthValues, context = {}) {
    const memo = new Map();
    const visiting = new Set();
    const formulas = Object.fromEntries(Object.entries(context.reportFormulaSheets || {}).map(([name, sheet]) =>
        [name, sheet.cells || {}]
    ));
    const availableSheets = new Set([
        ...Object.keys(formulas),
        context.monthlySheetView?.sheetName
    ].filter(Boolean));
    const hasUnavailableSheetReference = formula => {
        const referencePattern = /(?:'([^']+)'|((?:\[[^\]]+\])?[A-Za-z0-9 _.()-]+))!\$?[A-Z]{1,3}\$?\d+/gi;
        let match;
        while ((match = referencePattern.exec(formula))) {
            if (!availableSheets.has(match[1] || match[2])) return true;
        }
        return false;
    };
    const monthlyAssignmentState = context.getMonthlySheetAssignments(context.monthlySheetView, context.records || []);
    const monthlyOverflow = monthlyAssignmentState?.overflow || 0;
    const monthlyInsertionRow = monthlyAssignmentState?.insertionRow ?? 97;
    const columnNumber = letters => [...letters.toUpperCase()]
        .reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0) - 1;
    const referenceParts = token => {
        const match = token.match(/^(?:(?:'([^']+)'|((?:\[[^\]]+\])?[A-Za-z0-9 _.()-]+))!)?(\$?[A-Z]{1,3}\$?\d+)$/i);
        if (!match) throw new Error(`Tham chiếu không hợp lệ trong công thức báo cáo: ${token}`);
        return {
            sheet: match[1] || match[2] || '',
            address: match[3].replace(/\$/g, '')
        };
    };
    const getCellValue = (sheetName, address, sourceCell) => {
        const normalizedSheet = sheetName.replace(/^'|'$/g, '');
        if (normalizedSheet === context.monthlySheetView?.sheetName) {
            const reference = address.match(/^([A-Z]+)(\d+)$/i);
            const currentAddress = reference && monthlyOverflow &&
                Number(reference[2]) >= monthlyInsertionRow + 1
                ? `${reference[1]}${Number(reference[2]) + monthlyOverflow}`
                : address;
            return monthValues[currentAddress] ?? '';
        }
        if (/^\[\d+\]/.test(normalizedSheet)) return sourceCell?.value ?? 0;
        return calculateCell(normalizedSheet || sourceCell.sheetName, address);
    };
    const evaluateFormula = (formula, currentSheet, currentCell) => {
        const tokens = formula.match(/"(?:[^"]|"")*"|(?:'[^']+'|(?:\[[^\]]+\])?[A-Za-z0-9 _.()-]+)!\$?[A-Z]{1,3}\$?\d+|\$?[A-Z]{1,3}\$?\d+|\d+(?:\.\d+)?(?:E[+-]?\d+)?|<>|>=|<=|[A-Z_][A-Z0-9_.]*|[()+\-*\/&,=:<>{}]/gi);
        if (!tokens || tokens.join('').replace(/\s/g, '') !== formula.replace(/\s/g, '')) {
            throw new Error(`Công thức báo cáo không hỗ trợ: ${formula}`);
        }
        let position = 0;
        const peek = () => tokens[position];
        const take = () => tokens[position++];
        const numeric = value => value === '' || value === null || value === undefined ? 0 : Number(value) || 0;
        const compare = (left, operator, right) => {
            const leftNumber = left === '' ? 0 : Number(left);
            const rightNumber = right === '' ? 0 : Number(right);
            const bothNumeric = left !== '' && right !== '' &&
                Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
            const a = bothNumeric ? leftNumber : String(left ?? '').toLocaleLowerCase('vi');
            const b = bothNumeric ? rightNumber : String(right ?? '').toLocaleLowerCase('vi');
            if (operator === '=') return a === b;
            if (operator === '<>') return a !== b;
            if (operator === '>') return a > b;
            if (operator === '<') return a < b;
            if (operator === '>=') return a >= b;
            return a <= b;
        };
        const flatten = value => Array.isArray(value)
            ? value.flat(Infinity).flatMap(item => item?.range || [item])
            : value?.range || [value];
        const parseComparison = () => {
            let value = parseAdditive();
            while (['=', '<>', '>', '<', '>=', '<='].includes(peek())) {
                const operator = take();
                value = compare(value, operator, parseAdditive()) ? 1 : 0;
            }
            return value;
        };
        const parseAdditive = () => {
            let value = parseMultiplicative();
            while (peek() === '+' || peek() === '-' || peek() === '&') {
                const operator = take();
                const right = parseMultiplicative();
                value = operator === '+' ? numeric(value) + numeric(right)
                    : operator === '-' ? numeric(value) - numeric(right)
                        : `${value ?? ''}${right ?? ''}`;
            }
            return value;
        };
        const parseMultiplicative = () => {
            let value = parsePrimary();
            while (peek() === '*' || peek() === '/') {
                const operator = take();
                const right = parsePrimary();
                value = operator === '*' ? numeric(value) * numeric(right) : numeric(value) / numeric(right);
            }
            return value;
        };
        const parsePrimary = () => {
            const token = take();
            if (token === '(') {
                const value = parseComparison();
                if (take() !== ')') throw new Error(`Thiếu ngoặc đóng trong ${formula}`);
                return value;
            }
            if (token?.startsWith('"')) return token.slice(1, -1).replace(/""/g, '"');
            if (/^\d/.test(token || '')) return Number(token);
            if (/^(?:'[^']+'|(?:\[[^\]]+\])?[A-Za-z0-9 _.()-]+)!\$?[A-Z]{1,3}\$?\d+$/i.test(token || '') ||
                /^\$?[A-Z]{1,3}\$?\d+$/i.test(token || '')) {
                const start = referenceParts(token);
                if (peek() !== ':') {
                    return getCellValue(start.sheet, start.address, currentCell);
                }
                take();
                const endToken = take();
                const end = referenceParts(endToken);
                const sheetName = start.sheet || end.sheet || currentSheet;
                const startMatch = start.address.match(/^([A-Z]+)(\d+)$/i);
                const endMatch = end.address.match(/^([A-Z]+)(\d+)$/i);
                const values = [];
                for (let row = Number(startMatch[2]); row <= Number(endMatch[2]); row++) {
                    for (let column = columnNumber(startMatch[1]); column <= columnNumber(endMatch[1]); column++) {
                        const address = `${monthlyColumnName(column)}${row}`;
                        values.push(getCellValue(sheetName, address, currentCell));
                    }
                }
                return { range: values };
            }
            if (/^[A-Z_][A-Z0-9_.]*$/i.test(token || '') && peek() === '(') {
                take();
                const args = [];
                if (peek() !== ')') {
                    do {
                        args.push(parseComparison());
                        if (peek() !== ',') break;
                        take();
                    } while (position < tokens.length);
                }
                if (take() !== ')') throw new Error(`Thiếu ngoặc đóng trong ${formula}`);
                const name = token.toUpperCase();
                if (name === 'IF') return args[0] ? args[1] : args[2];
                if (name === 'SUM') return flatten(args).reduce((sum, value) => sum + numeric(value), 0);
                if (name === 'SUMIFS') {
                    if (args.length < 3 || args.length % 2 === 0) {
                        throw new Error(`Công thức SUMIFS không hợp lệ: ${formula}`);
                    }
                    const sumRange = flatten(args[0]);
                    const criteriaRanges = [];
                    for (let index = 1; index < args.length; index += 2) {
                        const range = flatten(args[index]);
                        if (range.length !== sumRange.length) {
                            throw new Error(`Các vùng trong SUMIFS không cùng kích thước: ${formula}`);
                        }
                        criteriaRanges.push([range, Array.isArray(args[index + 1]) ? args[index + 1] : [args[index + 1]]]);
                    }
                    const matchesCriteria = (value, criterion) => {
                        const text = String(criterion ?? '');
                        const match = text.match(/^(<>|>=|<=|>|<|=)(.*)$/);
                        const operator = match?.[1] || '=';
                        let expected = match ? match[2] : criterion;
                        if (typeof expected === 'string' && /[*?]/.test(expected)) {
                            const escaped = expected.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                                .replace(/\*/g, '.*')
                                .replace(/\?/g, '.');
                            const matched = new RegExp(`^${escaped}$`, 'i').test(String(value ?? ''));
                            return operator === '<>' ? !matched : matched;
                        }
                        if (expected === '') {
                            return operator === '<>' ? value !== '' && value !== null : value === '' || value === null;
                        }
                        const expectedNumber = Number(expected);
                        if (Number.isFinite(expectedNumber) && String(expected).trim() !== '') expected = expectedNumber;
                        return compare(value, operator, expected);
                    };
                    return sumRange.reduce((total, value, index) =>
                        criteriaRanges.every(([range, criteria]) =>
                            criteria.some(criterion => matchesCriteria(range[index], criterion))
                        )
                            ? total + numeric(value)
                            : total,
                    0);
                }
                throw new Error(`Hàm báo cáo chưa hỗ trợ: ${name}`);
            }
            throw new Error(`Giá trị công thức báo cáo không hỗ trợ: ${token}`);
        };
        const result = parseComparison();
        if (position !== tokens.length) throw new Error(`Phần công thức chưa xử lý: ${tokens.slice(position).join('')}`);
        return result;
    };
    const calculateCell = (sheetName, address) => {
        const normalized = sheetName.replace(/^'|'$/g, '');
        const key = `${normalized}!${address.replace(/\$/g, '')}`;
        if (memo.has(key)) return memo.get(key);
        const sheetCells = formulas[normalized];
        const cell = sheetCells?.[address.replace(/\$/g, '')];
        if (!cell) return 0;
        if (!cell.formula) return cell.value ?? '';
        if (hasUnavailableSheetReference(cell.formula)) {
            const cachedValue = cell.value ?? '';
            memo.set(key, cachedValue);
            return cachedValue;
        }
        if (visiting.has(key)) throw new Error(`Công thức vòng lặp trong báo cáo tại ${key}`);
        visiting.add(key);
        const result = evaluateFormula(cell.formula, normalized, { ...cell, sheetName: normalized });
        visiting.delete(key);
        memo.set(key, result);
        return result;
    };
    return (sheetName, address) => calculateCell(sheetName, address);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        calculateMonthlySheet,
        calculateReportFormulaSheets,
        getMonthlySheetAssignments: calculateMonthlySheetAssignments
    };
}
