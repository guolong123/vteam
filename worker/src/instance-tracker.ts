let activeInstances = 0;
let idleHandler: (() => void) | null = null;
let lastStartAt = 0;

export function trackInstanceStart(): number {
  activeInstances += 1;
  lastStartAt = Date.now();
  return activeInstances;
}

export function onActiveSessionsIdle(handler: (() => void) | null): void {
  idleHandler = handler;
}

export function trackInstanceEnd(): number {
  activeInstances = Math.max(0, activeInstances - 1);
  if (activeInstances === 0 && idleHandler) {
    idleHandler();
  }
  return activeInstances;
}

export function getLoad(maxInstances?: number): { instances: number } {
  if (maxInstances && maxInstances > 0 && activeInstances > maxInstances * 4) {
    activeInstances = maxInstances;
  }
  if (lastStartAt && activeInstances > 0 && Date.now() - lastStartAt > 30 * 60 * 1000) {
    activeInstances = 0;
  }
  return { instances: activeInstances };
}

export function resetInstanceCount(): void {
  activeInstances = 0;
  lastStartAt = 0;
}
