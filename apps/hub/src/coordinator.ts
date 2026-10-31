/** Serializes file operations independently of whether a Knowledge watcher is enabled. */
export class WriteCoordinator {
  private queue: Promise<void> = Promise.resolve();
  exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  async drain(): Promise<void> { await this.queue; }
}
