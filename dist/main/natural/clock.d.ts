/**
 * Local wall-clock, spelled out.
 *
 * A model has no clock. Without this it guesses from the conversation's tone and
 * says "tonight" at three in the afternoon. Printing the hour together with the
 * word people actually use for it - 凌晨 / 上午 / 中午 / 下午 / 晚上 / 深夜 - leaves
 * nothing to infer.
 */
export declare function naturalTimeStamp(now?: Date): string;
//# sourceMappingURL=clock.d.ts.map