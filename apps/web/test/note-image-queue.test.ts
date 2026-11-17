import { expect, test } from "bun:test";
import { ChangeSet } from "@codemirror/state";
import type { ImageUploadResult } from "@lumio/schema";
import { NoteImageQueue } from "../src/client/note-image-queue.ts";

const url = "https://images.example.com/photo.png";
const result: ImageUploadResult = { url, media_type: "image/png", size: 1 };
const image = (name: string) => new File(["x"], name, { type: "image/png" });

test("uploads retain the edited insertion point when leaving one note and reopening it", async () => {
  const first = Promise.withResolvers<ImageUploadResult>();
  const second = Promise.withResolvers<ImageUploadResult>();
  const files: string[] = [];
  const saved: string[] = [];
  let body = "Paragraph\nNext";
  const queue = new NoteImageQueue(file => {
    files.push(file.name);
    return files.length === 1 ? first.promise : second.promise;
  }, () => body, text => { body = text; }, () => saved.push(body), () => {});
  const connect = () => queue.connect({
    redraw() {},
    insert({ from, insert }) {
      queue.map(ChangeSet.of({ from, insert }, body.length));
      body = body.slice(0, from) + insert + body.slice(from);
    },
  });

  const detach = connect();
  queue.add([image("first.png"), image("second.png")], "Paragraph".length);
  expect(queue.pending.map(job => job.state)).toEqual(["uploading", "queued"]);
  expect(saved).toEqual([]);
  queue.map(ChangeSet.of({ from: 0, insert: "New " }, body.length));
  body = "New " + body;
  detach();

  first.resolve(result);
  await first.promise;
  expect(saved).toEqual([`New Paragraph\n![first](${url})\nNext`]);
  expect(files).toEqual(["first.png", "second.png"]);

  connect();
  second.resolve(result);
  await second.promise;
  expect(body).toBe(`New Paragraph\n![first](${url})\n![second](${url})\nNext`);
  expect(queue.hasPending).toBe(false);
});

test("a failed upload can be retried without inserting a link for a removed file", async () => {
  const first = Promise.withResolvers<ImageUploadResult>();
  const retry = Promise.withResolvers<ImageUploadResult>();
  const signals: AbortSignal[] = [];
  const saved: string[] = [];
  let body = "Text";
  const queue = new NoteImageQueue((_, signal) => {
    signals.push(signal);
    return signals.length === 1 ? first.promise : retry.promise;
  }, () => body, text => { body = text; }, () => saved.push(body), () => {});
  queue.add([image("retry.png")], 0);
  const [job] = queue.pending;
  first.reject(new Error("Upload failed"));
  await first.promise.catch(() => {});
  expect(job?.state).toBe("failed");
  expect(saved).toEqual([]);

  queue.retry(job!);
  expect(job?.state).toBe("uploading");
  queue.remove(job!);
  expect(signals[1]?.aborted).toBe(true);
  retry.resolve(result);
  await retry.promise;
  expect(saved).toEqual([]);
  expect(queue.hasPending).toBe(false);
});

test("signing out aborts the in-flight file and discards queued files", async () => {
  const gate = Promise.withResolvers<ImageUploadResult>();
  const signals: AbortSignal[] = [];
  const queue = new NoteImageQueue((_, signal) => {
    signals.push(signal);
    return gate.promise;
  }, () => "", () => { throw new Error("A disposed queue cannot edit a note"); }, () => {}, () => {});
  queue.add([image("first.png"), image("second.png")], 0);
  queue.dispose();
  expect(signals[0]?.aborted).toBe(true);
  gate.resolve(result);
  await gate.promise;
  expect(signals).toHaveLength(1);
  expect(queue.hasPending).toBe(false);
});
