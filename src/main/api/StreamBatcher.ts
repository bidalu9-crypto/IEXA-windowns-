export class StreamBatcher {
  private timer?: ReturnType<typeof setTimeout>;
  private text?: string;
  private thinking: string[] = [];
  private inputs = new Map<string, unknown>();
  constructor(private readonly send: (event: string, data: any) => void, private readonly interval = 80) {}

  emit(event: string, data: any): void {
    if (event === 'text') this.text = data.content;
    else if (event === 'thinking') this.thinking.push(data.content);
    else if (event === 'tool_input') this.inputs.set(data.id || data.name, data);
    else { this.flush(); this.send(event, data); return; }
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.interval);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.text !== undefined) this.send('text', { content: this.text });
    if (this.thinking.length) this.send('thinking', { content: this.thinking.join('') });
    for (const data of this.inputs.values()) this.send('tool_input', data);
    this.text = undefined;
    this.thinking = [];
    this.inputs.clear();
  }
}
