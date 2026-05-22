// Генерация ID

let _counter = 0;

export function generateId(): string {
  _counter += 1;
  return `${Date.now().toString(36)}-${_counter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function generateStreamId(): string {
  return `stream-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Форматирование дат

export function formatISODate(date: Date): string {
  return date.toISOString();
}

export function nowISO(): string {
  return new Date().toISOString();
}

// Безопасный JSON-парсинг

export function safeJsonParse<T>(data: string, fallback: T): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    return fallback;
  }
}

// Атомарная запись в файл (write → temp → rename)

export async function atomicWrite(
  writeFile: (path: string, data: string) => Promise<void>,
  rename: (oldPath: string, newPath: string) => Promise<void>,
  targetPath: string,
  data: string,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp.${generateId()}`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, targetPath);
}

// Асинхронный Mutex

export class AsyncLock {
  private _locked = false;
  private _waiting: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise((resolve) => {
      this._waiting.push(() => {
        this._locked = true;
        resolve();
      });
    });
  }

  release(): void {
    if (this._waiting.length > 0) {
      const next = this._waiting.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}
