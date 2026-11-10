/** The small VT subset used by the supported Claude usage screen. OSC/DCS never reach the host. */
export class ClaudeQuotaScreen {
  private cells: string[][] = [];
  private row = 0;
  private col = 0;
  private saved: [number, number] = [0, 0];
  private pending = "";
  private decoder = new TextDecoder();

  constructor(readonly cols = 160, readonly rows = 60) {}

  text(): string { return this.cells.map(row => (row ?? []).join("").trimEnd()).join("\n"); }

  feed(bytes: Uint8Array): void {
    const input = this.pending + this.decoder.decode(bytes, { stream: true });
    this.pending = "";
    for (let i = 0; i < input.length;) {
      const char = String.fromCodePoint(input.codePointAt(i)!);
      if (char === "\x1b") {
        const next = input[i + 1];
        if (next === "[") {
          const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])/.exec(input.slice(i));
          if (match) { this.control(match[1]!, match[3]!); i += match[0].length; continue; }
        } else if (next && "]P^_".includes(next)) {
          const end = /\x07|\x1b\\/.exec(input.slice(i + 2));
          if (end) { i += end.index + end[0].length + 2; continue; }
        } else if (next) {
          if (next === "7") this.saved = [this.row, this.col];
          if (next === "8") [this.row, this.col] = this.saved;
          if (next === "c") { this.cells = []; this.row = 0; this.col = 0; }
          i += 2;
          continue;
        }
        this.pending = input.slice(i);
        if (this.pending.length > 4096) throw new Error("Invalid terminal sequence");
        break;
      }
      if (char === "\r") this.col = 0;
      else if (char === "\n") this.line();
      else if (char === "\b") this.col = Math.max(0, this.col - 1);
      else if (char === "\t") this.col = Math.min(this.cols, (Math.floor(this.col / 8) + 1) * 8);
      else if (char >= " " && char !== "\x7f") {
        const width = Bun.stringWidth(char);
        if (width > 0) {
          if (this.col >= this.cols) { this.col = 0; this.line(); }
          const row = this.cells[this.row] ?? (this.cells[this.row] = []);
          while (row.length < this.col) row.push(" ");
          row[this.col++] = char;
          if (width === 2 && this.col < this.cols) row[this.col++] = " ";
        }
      }
      i += char.length;
    }
  }

  private line() {
    if (this.row < this.rows - 1) this.row++;
    else this.cells.shift();
  }

  private control(parameters: string, final: string) {
    if (parameters.startsWith("?")) {
      if (parameters === "?1049" && final === "h") { this.cells = []; this.row = 0; this.col = 0; }
      return;
    }
    const [first = 0, second = 0] = parameters.split(";").map(Number);
    const n = first || 1;
    switch (final) {
      case "A": this.row -= n; break;
      case "B": this.row += n; break;
      case "C": this.col += n; break;
      case "D": this.col -= n; break;
      case "E": this.row += n; this.col = 0; break;
      case "F": this.row -= n; this.col = 0; break;
      case "G": this.col = n - 1; break;
      case "d": this.row = n - 1; break;
      case "H":
      case "f": this.row = n - 1; this.col = (second || 1) - 1; break;
      case "J":
        if (first === 2 || first === 3) this.cells = [];
        else if (first === 0) { this.cells.length = Math.min(this.cells.length, this.row + 1); this.cells[this.row]?.splice(this.col); }
        else if (first === 1) {
          for (let i = 0; i < this.row; i++) this.cells[i] = [];
          this.cells[this.row]?.fill(" ", 0, this.col + 1);
        }
        break;
      case "K":
        if (first === 2) this.cells[this.row] = [];
        else if (first === 0) this.cells[this.row]?.splice(this.col);
        else if (first === 1) this.cells[this.row]?.fill(" ", 0, this.col + 1);
        break;
      case "s": this.saved = [this.row, this.col]; break;
      case "u": [this.row, this.col] = this.saved; break;
    }
    this.row = Math.max(0, Math.min(this.rows - 1, this.row));
    this.col = Math.max(0, Math.min(this.cols, this.col));
  }
}
