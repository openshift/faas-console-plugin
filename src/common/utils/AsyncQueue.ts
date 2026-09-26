// "…Stick a queue in there. Queues are the way to just get rid of this problem.
// If you're not using queues extensively, you should be.
// You should start right away, like right after this talk." -Rich Hickey
export class AsyncQueue<T> {
  private static readonly CLOSED_ERROR = 'queue closed';

  private queue: T[] = [];
  private consumers: { resolve: (value: T) => void; reject: (e: Error) => void }[] = [];
  private closed: boolean = false;

  enqueue(value: T): void {
    if (this.closed) throw new Error(AsyncQueue.CLOSED_ERROR);
    if (this.consumers.length > 0) {
      const consumer = this.consumers.shift()!;
      consumer.resolve(value);
    } else {
      this.queue.push(value);
    }
  }

  async dequeue(): Promise<T> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    if (this.closed) throw new Error(AsyncQueue.CLOSED_ERROR);

    return new Promise<T>((resolve, reject) => {
      this.consumers.push({ resolve, reject });
    });
  }

  close() {
    if (this.closed) throw new Error(AsyncQueue.CLOSED_ERROR);
    this.closed = true;
    this.consumers.forEach((c) => {
      c.reject(new Error(AsyncQueue.CLOSED_ERROR));
    });
    this.consumers.length = 0;
  }

  [Symbol.asyncIterator]() {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        try {
          const value = await this.dequeue();
          return { done: false, value };
        } catch (e) {
          if (e instanceof Error && e.message === AsyncQueue.CLOSED_ERROR) {
            return { done: true, value: undefined };
          }
          throw e;
        }
      },
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.closed) {
      this.close();
    }
  }
}
