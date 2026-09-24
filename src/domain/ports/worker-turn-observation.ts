export interface WorkerTurnWatch {
  flush(): Promise<void>;
  stop(): Promise<void>;
  detach(): Promise<void>;
}

export interface WorkerTurnObservationPort {
  watch(turnId: string): Promise<WorkerTurnWatch | null>;
  recover(turnId: string): Promise<void>;
}
