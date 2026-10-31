import { createHash } from "node:crypto";
import { newId } from "@lumio/foundation";

/**
 * 例行任务某一次的 Job 编号（ADR 0019 第 6 节、P2-5）：时间部分是计划触发时间，随机部分取
 * `routine ID + 触发时间` 的哈希。同一次触发不论生成多少遍都是同一个编号，Hub 也能据此认出它属于哪个例行任务。
 */
export function routineJobId(routine: string, firedAt: Date): string {
  const digest = createHash("sha256").update(`${routine}\0${firedAt.toISOString()}`).digest();
  return newId("job", firedAt, () => digest.subarray(0, 10));
}
