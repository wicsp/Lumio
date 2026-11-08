import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
interface Proc {
    pid: number;
    parent: number;
    group: number;
    name: string;
}
/** Track observed descendants as well as the original detached process group. */
export class NativeProcessScope {
    private seen = new Map<number, Proc>();
    private timer?: ReturnType<typeof setInterval>;
    private collecting = false;
    constructor(private root: number) { this.timer = setInterval(() => void this.collect(), 250); }
    private async snapshot(): Promise<Proc[]> { try {
        const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,pgid=,comm="], { maxBuffer: 2 * 1024 * 1024 });
        return stdout.split("\n").flatMap(line => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line); return m ? [{ pid: Number(m[1]), parent: Number(m[2]), group: Number(m[3]), name: m[4]! }] : []; });
    }
    catch {
        return [];
    } }
    async collect() { if (this.collecting)
        return; this.collecting = true; try {
        const all = await this.snapshot();
        const ids = new Set([this.root]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const p of all)
                if ((ids.has(p.parent) || p.group === this.root) && !ids.has(p.pid)) {
                    ids.add(p.pid);
                    changed = true;
                }
        }
        for (const p of all)
            if (ids.has(p.pid))
                this.seen.set(p.pid, p);
    }
    finally {
        this.collecting = false;
    } }
    async stop(): Promise<boolean> {
        clearInterval(this.timer);
        await this.collect();
        const terminate = async (signal: NodeJS.Signals) => { const all = await this.snapshot(); for (const p of all) {
            const prior = this.seen.get(p.pid);
            if (prior && prior.name === p.name && prior.group === p.group) {
                try {
                    process.kill(p.pid, signal);
                }
                catch { }
            }
        } try {
            process.kill(-this.root, signal);
        }
        catch { } };
        await terminate("SIGTERM");
        await Bun.sleep(150);
        await terminate("SIGKILL");
        await Bun.sleep(100);
        const left = await this.snapshot();
        return !left.some(p => p.group === this.root || (this.seen.get(p.pid)?.name === p.name && this.seen.get(p.pid)?.group === p.group));
    }
}
