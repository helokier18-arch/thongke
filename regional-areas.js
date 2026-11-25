'use strict';

(function exposeRegionalAreas(root) {
    const AREA_NAMES = Object.freeze([
        'Cửa Việt', 'Cồn Cỏ', 'Hòn La', 'Cửa Gianh', 'Mỹ Thủy', 'Lèn Bảng'
    ]);
    function normalize(value) {
        return String(value || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
            .replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }
    const AREA_ALIASES = new Map([
        ['Cửa Việt', ['cua viet']], ['Cồn Cỏ', ['con co', 'conco']],
        ['Hòn La', ['hon la']], ['Cửa Gianh', ['cua gianh', 'song gianh']],
        ['Mỹ Thủy', ['my thuy']], ['Lèn Bảng', ['len bang']]
    ]);
    function classifyPortArea(value) {
        const port = normalize(value);
        if (!port) return null;
        for (const [area, aliases] of AREA_ALIASES) {
            if (aliases.some(alias => port === alias || port.includes(` ${alias} `) ||
                port.startsWith(`${alias} `) || port.endsWith(` ${alias}`))) return area;
        }
        return null;
    }
    const api = Object.freeze({ AREA_NAMES, classifyPortArea });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root && typeof root === 'object') {
        root.classifyPortArea = classifyPortArea;
        root.MARITIME_AREAS = api;
        root.MaritimeRegionalAreas = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
