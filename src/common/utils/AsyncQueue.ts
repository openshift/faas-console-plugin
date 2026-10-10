// AsyncQueue is a simple FIFO queue for async producer-consumer patterns.
// `enqueue(value)` is synchronous and buffers values. `dequeue()` is async: returns
// immediately with buffered values, otherwise waits for `enqueue()`. Both throw
// if queue is closed (`enqueue` always, `dequeue` only if no buffered values).
// Supports async iteration via `for await...of` and automatic cleanup via `using`
// statements (`Symbol.dispose`).
//
// "…Stick a queue in there. Queues are the way to just get rid of this problem.
// If you're not using queues extensively, you should be.
// You should start right away, like right after this talk." -Rich Hickey
export class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T>, Disposable {
  static readonly #CLOSED_ERROR = 'queue closed';

  #queue: T[] = [];
  #consumers: ((result: IteratorResult<T>) => void)[] = [];
  #closed: boolean = false;

  enqueue(value: T): void {
    if (this.#closed) throw new Error(AsyncQueue.#CLOSED_ERROR);
    if (this.#consumers.length > 0) {
      const resolve = this.#consumers.shift()!;
      resolve({ done: false, value });
    } else {
      this.#queue.push(value);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.#queue.length > 0) {
      return { done: false, value: this.#queue.shift()! };
    }
    if (this.#closed) {
      return { done: true, value: undefined };
    }

    return new Promise<IteratorResult<T>>((resolve) => {
      this.#consumers.push(resolve);
    });
  }

  async dequeue(): Promise<T> {
    const result = await this.next();
    if (result.done) {
      throw new Error(AsyncQueue.#CLOSED_ERROR);
    }
    return result.value;
  }

  close() {
    if (this.#closed) throw new Error(AsyncQueue.#CLOSED_ERROR);
    this.#closed = true;
    this.#consumers.forEach((resolve) => {
      resolve({ done: true, value: undefined });
    });
    this.#consumers.length = 0;
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  [Symbol.dispose](): void {
    if (!this.#closed) {
      this.close();
    }
  }
}
