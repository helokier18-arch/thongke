'use strict';

(function exposeRegionalAreas(root) {
    const AREA_NAMES = Object.freeze([
        'Cửa Việt', 'Cồn Cỏ', 'Hòn La', 'Cửa Gianh', 'Mỹ Thủy', 'Lèn Bảng'
    ]);

    function normalizePortAreaName(value) {
        return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    const PORTS_BY_AREA = Object.freeze({
        'Cửa Việt': Object.freeze([
            'Bến cảng Cửa Việt',
            'Bến cảng Hợp Thịnh',
            'Bến cảng Xăng dầu Hải Hà',
            'Bến cảng số 4 (Hành khách)',
            'Bến cảng CFG Quảng Trị',
            'Bến phao Xăng dầu Hưng Phát',
            'Khu chuyển tải số 2 tại Cửa Việt',
            'Bến TNĐ Gio Mai'
        ]),
        'Cồn Cỏ': Object.freeze([
            'Cảng cá Cồn Cỏ'
        ]),
        'Hòn La': Object.freeze([
            'Bến cảng PTSC Hòn La',
            'Bến cảng Tổng hợp Quốc tế Hòn La',
            'Bến cảng Nhiệt điện Quảng Trạch I',
            'Khu chuyển tải Hòn La'
        ]),
        'Cửa Gianh': Object.freeze([
            'Bến cảng Gianh',
            'Bến cảng Thắng Lợi',
            'Bến cảng Xăng dầu Sông Gianh',
            'Khu chuyển tải tại Cửa Gianh'
        ]),
        'Mỹ Thủy': Object.freeze([
            'Bến cảng Tổng hợp Quốc tế Mỹ Thủy'
        ]),
        'Lèn Bảng': Object.freeze([
            'Bến TNĐ Lèn Bảng',
            'Bến TNĐ Đức Toàn',
            'Bến TNĐ VCM Văn Hóa',
            'Bến TNĐ 207',
            'Bến TNĐ Quảng Trường',
            'Bến TNĐ Thái Hoàng',
            'Bến TNĐ Xuân Sơn - Phong Nha',
            'Bến TNĐ Tùng Cát',
            'Bến TNĐ Toàn Phát',
            'Bến TNĐ Thiên Sơn',
            'Bến TNĐ Nhật Lệ Travel',
            'Bến TNĐ Hoàng Phúc',
            'Bến TNĐ Lê Anh Dũng',
            'Bến TNĐ Hoàng Văn Lưu',
            'Bến TNĐ Xăng dầu Nhật Minh',
            'Vũng neo đậu TNĐ thượng lưu Bến Lèn Bảng',
            'Vũng neo đậu TNĐ hạ lưu Bến Lèn Bảng',
            'Vũng neo đậu TNĐ hạ lưu Bến Đức Toàn'
        ])
    });

    const AREA_ALIASES = new Map([
        ['Cửa Việt', ['cua viet']], ['Cồn Cỏ', ['con co', 'conco']],
        ['Hòn La', ['hon la']], ['Cửa Gianh', ['cua gianh', 'song gianh']],
        ['Mỹ Thủy', ['my thuy']], ['Lèn Bảng', ['len bang']]
    ]);

    const PORT_AREA_ALIASES = new Map([
        ['Cửa Việt', ['Cầu số 4', 'Cảng khách', 'Hải Hà', 'Hợp Thịnh', 'TNĐ Gio Mai', 'BẾN TNĐ GIO MAI']],
        ['Hòn La', ['Bến cảng Nhiệt điện Quảng Trạch 1']],
        ['Cửa Gianh', ['Khu Chuyển Tải Cửa Gianh']]
    ]);
    const PORT_AREA_BY_NAME = new Map();
    Object.entries(PORTS_BY_AREA).forEach(([area, ports]) => {
        ports.forEach(port => PORT_AREA_BY_NAME.set(normalizePortAreaName(port), area));
    });
    PORT_AREA_ALIASES.forEach((ports, area) => {
        ports.forEach(port => PORT_AREA_BY_NAME.set(normalizePortAreaName(port), area));
    });

    function classifyPortArea(value, explicitArea = '') {
        const port = normalizePortAreaName(value);
        if (port) {
            const mappedArea = PORT_AREA_BY_NAME.get(port);
            if (mappedArea) return mappedArea;

            for (const [area, aliases] of AREA_ALIASES) {
                if (aliases.some(alias => port === alias || port.includes(` ${alias} `) ||
                    port.startsWith(`${alias} `) || port.endsWith(` ${alias}`))) return area;
            }
        }
        return AREA_NAMES.includes(explicitArea) ? explicitArea : null;
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
