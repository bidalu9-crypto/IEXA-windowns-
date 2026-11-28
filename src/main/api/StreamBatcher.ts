/** Coalesce adjacent deltas only. Grouping all text before all reasoning used
 * to reverse event order and made a faithful transcript impossible.
 *
 * The interval is the longest the client can go without hearing anything. An
 * 80ms window merged whatever the model produced in that time into one frame;
 * a model that speeds up after reasoning then handed the reader a whole
 * paragraph at once. 40ms halves the worst-case chunk without doubling the
 * event count to the point where the socket work dominates. */
export class StreamBatcher {
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Array<{ event: string; data: any }> = [];
  constructor(private readonly send: (event: string, data: any) => void, private readonly interval = 40) {}
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
