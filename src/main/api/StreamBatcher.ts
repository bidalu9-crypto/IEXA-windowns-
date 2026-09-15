/** Coalesce adjacent deltas only. Grouping all text before all reasoning used
 * to reverse event order and made a faithful transcript impossible. */
export class StreamBatcher {
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Array<{ event: string; data: any }> = [];
  constructor(private readonly send: (event: string, data: any) => void, private readonly interval = 80) {}
  emit(event: string, data: any): void {
    if (!['text', 'thinking', 'tool_input'].includes(event)) { this.flush(); this.send(event, data); return; }
    const last = this.pending.at(-1);
    const same = last?.event === event && (event !== 'tool_input' || (last.data.id || last.data.name) === (data.id || data.name));
    if (same && last) last.data = event === 'thinking' ? { ...last.data, content: String(last.data.content || '') + String(data.content || '') } : { ...data };
    else this.pending.push({ event, data: { ...data } });
    if (this.pending.length >= 128) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.interval);
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Detach before callbacks so reentrant events remain queued for the next flush.
    const batch = this.pending; this.pending = [];
    for (const { event, data } of batch) this.send(event, data);
  }
}
