import { describe, it, expect } from 'vitest';
import { AsyncQueue } from './AsyncQueue';

describe('AsyncQueue', () => {
  it('dequeue waits for enqueued value', async () => {
    await using queue = new AsyncQueue<string>();

    const deqPromise = queue.dequeue();

    queue.enqueue('value');
    await expect(deqPromise).resolves.toBe('value');
  });

  it('close() rejects all pending consumers', async () => {
    const queue = new AsyncQueue<string>();

    const p1 = queue.dequeue();
    const p2 = queue.dequeue();
    const p3 = queue.dequeue();

    queue.close();

    await expect(p1).rejects.toThrow('queue closed');
    await expect(p2).rejects.toThrow('queue closed');
    await expect(p3).rejects.toThrow('queue closed');
  });

  it('buffers values drain before closure is reported', async () => {
    const queue = new AsyncQueue<string>();

    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('c');
    queue.close();

    const results = [];
    for await (const val of queue) {
      results.push(val);
    }

    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('enqueue() after close throws', async () => {
    const queue = new AsyncQueue<string>();
    queue.close();

    expect(() => queue.enqueue('value')).toThrow('queue closed');
  });

  it('repeated close() throws', async () => {
    const queue = new AsyncQueue<string>();

    queue.close();

    expect(() => queue.close()).toThrow('queue closed');
  });

  it('async iterator delivers values in order', async () => {
    const queue = new AsyncQueue<number>();

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    queue.close();

    const results = [];
    for await (const val of queue) {
      results.push(val);
    }

    expect(results).toEqual([1, 2, 3]);
  });

  it('drains all 10k concurrently enqueued values', async () => {
    const queue = new AsyncQueue<number>();
    queueMicrotask(async () => {
      for (let i = 0; i <= 10_000; i++) {
        queue.enqueue(i);
        await new Promise<void>((resolve) => {
          queueMicrotask(() => resolve());
        });
      }
      queue.close();
    });

    const createConsumer = async () => {
      let sum = 0;
      for await (const val of queue) {
        sum += val;
      }
      return sum;
    };

    const results = await Promise.all(Array.from({ length: 100 }, () => createConsumer()));

    const totalSum = results.reduce((a, b) => a + b, 0);
    expect(totalSum).toBe(50005000);
  });

  it('matches one enqueued value to one waiting consumer', async () => {
    const queue = new AsyncQueue<string>();

    const p1 = queue.dequeue();
    const p2 = queue.dequeue();
    const p3 = queue.dequeue();
    const p4 = queue.dequeue();
    const p5 = queue.dequeue();

    queue.enqueue('only-one');

    const resolved = await Promise.race([
      p1.then((v) => ({ promise: 'p1', value: v })),
      p2.then((v) => ({ promise: 'p2', value: v })),
      p3.then((v) => ({ promise: 'p3', value: v })),
      p4.then((v) => ({ promise: 'p4', value: v })),
      p5.then((v) => ({ promise: 'p5', value: v })),
    ]);

    expect(resolved.value).toBe('only-one');
    expect(resolved.promise).toBe('p1');

    queue.close();
    const remaining = await Promise.allSettled([p1, p2, p3, p4, p5]);
    const rejected = remaining.filter((r) => r.status === 'rejected').length;
    expect(rejected).toBe(4);
  });

  it('dequeue rejects after async disposal', async () => {
    const q = await (async () => {
      await using queue = new AsyncQueue<string>();
      return queue;
    })();

    await expect(q.dequeue()).rejects.toThrow('queue closed');
  });
});
