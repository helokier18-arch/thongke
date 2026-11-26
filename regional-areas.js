'use strict';

(function exposeRegionalAreas(root) {
    const AREA_NAMES = Object.freeze([
        'Cửa Việt', 'Cồn Cỏ', 'Hòn La', 'Cửa Gianh', 'Mỹ Thủy', 'Lèn Bảng'
    ]);

    // Keep the area-to-port structure available to the form. Port lists are
    // intentionally empty until verified port names are configured; existing
    // vessel records are still offered as legacy options by main.html.
    const PORTS_BY_AREA = Object.freeze(Object.fromEntries(
        AREA_NAMES.map(area => [area, Object.freeze([])])
    ));

    function normalizePortAreaName(value) {
        return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    const AREA_ALIASES = new Map([
        ['Cửa Việt', ['cua viet']], ['Cồn Cỏ', ['con co', 'conco']],
        ['Hòn La', ['hon la']], ['Cửa Gianh', ['cua gianh', 'song gianh']],
        ['Mỹ Thủy', ['my thuy']], ['Lèn Bảng', ['len bang']]
    ]);

    function classifyPortArea(value, explicitArea = '') {
        if (AREA_NAMES.includes(explicitArea)) return explicitArea;

        const port = normalizePortAreaName(value);
        if (!port) return null;

        for (const [area, aliases] of AREA_ALIASES) {
            if (aliases.some(alias => port === alias || port.includes(` ${alias} `) ||
                port.startsWith(`${alias} `) || port.endsWith(` ${alias}`))) return area;
        }
        return null;
    }

    const api = Object.freeze({
        AREA_NAMES,
        PORTS_BY_AREA,
        normalizePortAreaName,
        classifyPortArea
    });

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root && typeof root === 'object') {
        root.classifyPortArea = classifyPortArea;
        root.MARITIME_AREAS = api;
        root.MaritimeRegionalAreas = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
