// ── ReadWriteLock ────────────────────────────────────────────────────────────
// Promise-based, write-preferring read-write lock.
// New reads queue behind pending writes to prevent write starvation.

type Waiter = () => void;

export class ReadWriteLock {
  private readers = 0;
  private writing = false;
  private readQueue: Waiter[] = [];
  private writeQueue: Waiter[] = [];

  async read<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireRead();
    try {
      return await fn();
    } finally {
      this.releaseRead();
    }
  }

  async write<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireWrite();
    try {
      return await fn();
    } finally {
      this.releaseWrite();
    }
  }

  private acquireRead(): Promise<void> {
    if (!this.writing && this.writeQueue.length === 0) {
      this.readers++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.readQueue.push(() => {
        this.readers++;
        resolve();
      });
    });
  }

  private releaseRead(): void {
    this.readers--;
    this.drain();
  }

  private acquireWrite(): Promise<void> {
    if (!this.writing && this.readers === 0) {
      this.writing = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.writeQueue.push(() => {
        this.writing = true;
        resolve();
      });
    });
  }

  private releaseWrite(): void {
    this.writing = false;
    this.drain();
  }

  private drain(): void {
    // Write-preferring: service writes first
    if (this.writeQueue.length > 0 && !this.writing && this.readers === 0) {
      const next = this.writeQueue.shift()!;
      next();
      return;
    }
    // If no pending writes, release all queued readers
    if (this.writeQueue.length === 0 && !this.writing) {
      while (this.readQueue.length > 0) {
        const next = this.readQueue.shift()!;
        next();
      }
    }
  }
}
