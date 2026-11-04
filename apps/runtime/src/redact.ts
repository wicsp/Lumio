/** Keeps a suffix so credentials split across output chunks cannot escape into logs. */
export class CredentialRedactor {
  private pending = Buffer.alloc(0);
  private readonly values: Buffer[];
  constructor(secrets: string[]) { this.values = [...new Set(secrets.filter(Boolean))].map(value => Buffer.from(value)); }
  push(chunk: Buffer, final = false): Buffer {
    this.pending = Buffer.concat([this.pending, chunk]);
    const output: Buffer[] = [], reserve = final ? 0 : Math.max(0, ...this.values.map(value => value.length - 1));
    while (this.pending.length) {
      let index = -1, matched: Buffer | undefined;
      for (const value of this.values) {
        const at = this.pending.indexOf(value);
        if (at >= 0 && (index < 0 || at < index)) { index = at; matched = value; }
      }
      if (matched) {
        output.push(this.pending.subarray(0, index), Buffer.from("[REDACTED]"));
        this.pending = this.pending.subarray(index + matched.length);
      } else {
        const count = Math.max(0, this.pending.length - reserve);
        output.push(this.pending.subarray(0, count)); this.pending = this.pending.subarray(count); break;
      }
    }
    return Buffer.concat(output);
  }
}
