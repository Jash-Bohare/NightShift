"use client";

import { useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;
let currentTime: number | null = null;

function subscribe(listener: Listener): () => void {
  listeners.add(listener);

  if (!timer) {
    currentTime = Date.now();
    timer = setInterval(() => {
      currentTime = Date.now();
      for (const subscriber of listeners) subscriber();
    }, 1000);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number | null {
  return currentTime;
}

function getServerSnapshot(): null {
  return null;
}

export function useClock(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
