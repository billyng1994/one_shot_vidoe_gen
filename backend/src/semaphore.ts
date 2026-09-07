export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async use<T>(task: () => Promise<T>) {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire() {
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release() {
    this.active -= 1;
    this.queue.shift()?.();
  }
}
