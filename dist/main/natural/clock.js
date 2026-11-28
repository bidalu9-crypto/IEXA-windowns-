"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.naturalTimeStamp = naturalTimeStamp;
/**
 * Local wall-clock, spelled out.
 *
 * A model has no clock. Without this it guesses from the conversation's tone and
 * says "tonight" at three in the afternoon. Printing the hour together with the
 * word people actually use for it - 凌晨 / 上午 / 中午 / 下午 / 晚上 / 深夜 - leaves
 * nothing to infer.
 */
function naturalTimeStamp(now = new Date()) {
    const hour = now.getHours();
    const period = hour < 6 ? '凌晨'
        : hour < 12 ? '上午'
            : hour < 13 ? '中午'
                : hour < 18 ? '下午'
                    : hour < 23 ? '晚上'
                        : '深夜';
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${weekday} ${pad(hour)}:${pad(now.getMinutes())}（${period}）`;
}
//# sourceMappingURL=clock.js.map