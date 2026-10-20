import type { Logger } from "pino";
import type { RetentionStore } from "../domain/ports/retention.js";
import { RETENTION_COMPACTION_PAGE_LIMIT } from "../domain/ports/retention-compaction.js";
import type { AuditSkeletonSourceKind, RetentionRefusalReason } from "../domain/retention-barrier.js";

const PAYLOAD_RETENTION_SOURCES: readonly AuditSkeletonSourceKind[] = [
  "answer_timeline_item", "conversation_segment_item", "delivery"
];

export class OutboxRetentionMaintainer {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private stopping = false;
  private nextPayloadSourceIndex = 0;

  constructor(
    private readonly store: RetentionStore,
    private readonly options: {
      retentionDays: number; batchSize: number; maxBatches?: number; intervalMs?: number; timeBudgetMs?: number;
      payloadCompactionEnabled?: boolean;
      coreEventMode?: "off" | "audit" | "compact";
      coreEventRetentionMs?: number;
      monotonicNow?: () => number; yieldNow?: () => Promise<void>;
    },
    private readonly logger: Pick<Logger, "info" | "error">
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    void this.run();
    this.timer = setInterval(() => this.run(), this.options.intervalMs ?? 3_600_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const running = this.running;
    if (running) await running;
  }

  run(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.pruneBatches().finally(() => { this.running = null; });
    return this.running;
  }

  private async pruneBatches(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - this.options.retentionDays * 86_400_000).toISOString();
      const maxBatches = this.options.maxBatches ?? 20;
      const coreDiscriminators = this.store.backfillCoreEventDiscriminators
        ? await this.backfillCoreEventDiscriminators(maxBatches)
        : { processed: 0, batches: 0, complete: true };
      if (coreDiscriminators.processed > 0) this.logger.info({
        event: "core-event-discriminator-backfill", processed: coreDiscriminators.processed,
        batches: coreDiscriminators.batches, complete: coreDiscriminators.complete, outcome: "normalized"
      }, "normalized bounded Core event discriminator batches");
      const deliveryDebt = this.store.classifyHistoricalDeliveryDebt
        ? await this.classifyDeliveryDebt(cutoff, maxBatches)
        : { settled: 0, released: 0, deliveryRecoveriesClassified: 0, projectionGapsClassified: 0, batches: 0 };
      const compacted = this.store.compactDeliveryIntents
        ? await this.pruneKind((limit) => this.store.compactDeliveryIntents!(limit), maxBatches)
        : { removed: 0, batches: 0 };
      const projectionGaps = this.store.pruneCompensatedProjectionGaps
        ? await this.pruneKind((limit) => this.store.pruneCompensatedProjectionGaps!(cutoff, limit), maxBatches)
        : { removed: 0, batches: 0 };
      const payloadCompaction = await this.compactPayloads(maxBatches);
      const coreEventRetention = await this.maintainCoreEvents(maxBatches, coreDiscriminators.complete);
      const inbound = await this.pruneKind((limit) => this.store.pruneAcceptedInboundMessages(cutoff, limit), maxBatches);
      const sessionOperations = await this.pruneKind((limit) => this.store.pruneTerminalSessionOperations(cutoff, limit), maxBatches);
      const removed = deliveryDebt.settled + projectionGaps.removed + inbound.removed + sessionOperations.removed;
      const debtChanged = deliveryDebt.settled + deliveryDebt.released + deliveryDebt.deliveryRecoveriesClassified + deliveryDebt.projectionGapsClassified;
      if (removed > 0 || compacted.removed > 0 || payloadCompaction.compacted > 0 || coreEventRetention.compacted > 0 || debtChanged > 0) this.logger.info({
        event: "durable-history-pruned", removed, deliveryDebtSettled: deliveryDebt.settled,
        deliveryQuarantinesReleased: deliveryDebt.released, deliveryRecoveriesClassified: deliveryDebt.deliveryRecoveriesClassified,
        projectionGapsClassified: deliveryDebt.projectionGapsClassified, deliveryDebtBatches: deliveryDebt.batches,
        deliveryIntentsCompacted: compacted.removed, payloadsCompacted: payloadCompaction.compacted,
        payloadCompactionPages: payloadCompaction.pages, payloadCompactionRefusals: payloadCompaction.refusals,
        payloadCompactionDeadlineExhausted: payloadCompaction.deadlineExhausted,
        coreEventRetentionMode: coreEventRetention.mode, coreEventPayloadsCompacted: coreEventRetention.compacted,
        projectionGapsRemoved: projectionGaps.removed, inboundRemoved: inbound.removed,
        sessionOperationRemoved: sessionOperations.removed, compactionBatches: compacted.batches,
        projectionGapBatches: projectionGaps.batches, inboundBatches: inbound.batches,
        sessionOperationBatches: sessionOperations.batches, cutoff, limit: this.options.batchSize, maxBatches, outcome: "pruned"
      }, "classified historical delivery debt, compacted retained payloads and intents, and pruned retained history");
      else if (payloadCompaction.pages > 0 || payloadCompaction.deadlineExhausted) this.logger.info({
        event: "retention-payload-maintenance", payloadsCompacted: 0,
        payloadCompactionPages: payloadCompaction.pages, payloadCompactionRefusals: payloadCompaction.refusals,
        payloadCompactionDeadlineExhausted: payloadCompaction.deadlineExhausted,
        outcome: "observed"
      }, "observed bounded retained payload maintenance");
      return removed;
    } catch (error) {
      this.logger.error({ event: "outbox-retention-failed", err: error, outcome: "failed" }, "failed to prune retained Lark outbox history");
      return 0;
    }
  }

  private async compactPayloads(maxBatches: number): Promise<{
    compacted:number; pages:number; refusals:Partial<Record<RetentionRefusalReason,number>>; deadlineExhausted:boolean;
  }> {
    if (!this.options.payloadCompactionEnabled || typeof this.store.compactPage !== "function") {
      return { compacted:0,pages:0,refusals:{},deadlineExhausted:false };
    }
    const monotonicNow=this.options.monotonicNow??(()=>performance.now());
    const yieldNow=this.options.yieldNow??(()=>new Promise<void>((resolve)=>setImmediate(resolve)));
    const deadline=monotonicNow()+(this.options.timeBudgetMs??250);
    const active=new Set(PAYLOAD_RETENTION_SOURCES);
    const sourceOrder = PAYLOAD_RETENTION_SOURCES.map((_, offset) =>
      PAYLOAD_RETENTION_SOURCES[(this.nextPayloadSourceIndex + offset) % PAYLOAD_RETENTION_SOURCES.length]!
    );
    const pagesBySource=new Map<AuditSkeletonSourceKind,number>();
    const refusals:Partial<Record<RetentionRefusalReason,number>>={};
    let compacted=0;let pages=0;let deadlineExhausted=false;
    while(!this.stopping&&active.size>0){
      let progressed=false;
      for(const source of sourceOrder){
        if(!active.has(source))continue;
        if(monotonicNow()>=deadline){deadlineExhausted=true;return {compacted,pages,refusals,deadlineExhausted};}
        const used=pagesBySource.get(source)??0;
        if(used>=maxBatches){active.delete(source);continue;}
        const page=this.store.compactPage({kind:source,evaluatedAt:new Date().toISOString(),limit:Math.min(this.options.batchSize,RETENTION_COMPACTION_PAGE_LIMIT)});
        this.nextPayloadSourceIndex=(PAYLOAD_RETENTION_SOURCES.indexOf(source)+1)%PAYLOAD_RETENTION_SOURCES.length;
        pagesBySource.set(source,used+1);pages+=1;compacted+=page.compacted;progressed=true;
        for(const [reason,count] of Object.entries(page.refusals) as Array<[RetentionRefusalReason,number]>)refusals[reason]=(refusals[reason]??0)+count;
        if(page.cycleComplete||used+1>=maxBatches)active.delete(source);
        if(this.stopping)return {compacted,pages,refusals,deadlineExhausted};
        if(active.size>0)await yieldNow();
      }
      if(!progressed)break;
    }
    return {compacted,pages,refusals,deadlineExhausted};
  }

  private async maintainCoreEvents(maxBatches: number, coreReady: boolean): Promise<{
    mode:"off"|"audit"|"compact"; pages:number; scanned:number; eligible:number; alreadyVerified:number;
    eligibleBytes:number; compacted:number; refusals:Partial<Record<RetentionRefusalReason,number>>; deadlineExhausted:boolean;
  }> {
    const mode = this.options.coreEventMode ?? "off";
    const empty = { mode, pages:0, scanned:0, eligible:0, alreadyVerified:0, eligibleBytes:0, compacted:0, refusals:{}, deadlineExhausted:false };
    if (mode === "off" || !coreReady) return empty;
    const retentionWindowMs = this.options.coreEventRetentionMs ?? 24 * 60 * 60 * 1_000;
    const monotonicNow = this.options.monotonicNow ?? (() => performance.now());
    const yieldNow = this.options.yieldNow ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    const deadline = monotonicNow() + (this.options.timeBudgetMs ?? 250);
    let pages=0;let scanned=0;let eligible=0;let alreadyVerified=0;let eligibleBytes=0;let compacted=0;let deadlineExhausted=false;
    const refusals:Partial<Record<RetentionRefusalReason,number>>={};
    try {
      while(!this.stopping&&pages<maxBatches){
        if(monotonicNow()>=deadline){deadlineExhausted=true;break;}
        const evaluatedAt=new Date().toISOString();
        const limit=Math.min(this.options.batchSize,RETENTION_COMPACTION_PAGE_LIMIT);
        let cycleComplete=false;
        if(mode==="audit"){
          const page=this.store.auditPage({kind:"core_event",evaluatedAt,retentionWindowMs,limit});
          pages+=1;scanned+=page.scanned;eligibleBytes+=page.eligibleBytes;
          eligible+=page.eligible;alreadyVerified+=page.alreadyVerified;
          cycleComplete=page.cycleComplete;
          for(const [reason,count] of Object.entries(page.refusals) as Array<[RetentionRefusalReason,number]>)refusals[reason]=(refusals[reason]??0)+count;
        }else{
          const page=this.store.compactPage({kind:"core_event",evaluatedAt,retentionWindowMs,limit});
          pages+=1;scanned+=page.scanned;eligibleBytes+=page.eligibleBytes??0;
          compacted+=page.compacted;eligible+=page.compacted+page.alreadyCompacted;
          alreadyVerified+=page.alreadyCompacted;
          cycleComplete=page.cycleComplete;
          for(const [reason,count] of Object.entries(page.refusals) as Array<[RetentionRefusalReason,number]>)refusals[reason]=(refusals[reason]??0)+count;
        }
        if(cycleComplete)break;
        if(!this.stopping&&pages<maxBatches)await yieldNow();
      }
      const result={mode,pages,scanned,eligible,alreadyVerified,eligibleBytes,compacted,refusals,deadlineExhausted};
      if(pages>0||deadlineExhausted)this.logger.info({
        event:"core-event-retention-maintenance",...result,outcome:mode==="audit"?"observed":"compacted"
      },"maintained bounded Core event retention evidence");
      return result;
    }catch(error){
      this.logger.error({event:"core-event-retention-failed",mode,err:error,outcome:"failed"},"failed bounded Core event retention maintenance");
      return {mode,pages,scanned,eligible,alreadyVerified,eligibleBytes,compacted,refusals,deadlineExhausted};
    }
  }

  private async backfillCoreEventDiscriminators(maxBatches: number): Promise<{ processed: number; batches: number; complete: boolean }> {
    let processed = 0;
    let batches = 0;
    let complete = false;
    while (!this.stopping && batches < maxBatches) {
      const result = this.store.backfillCoreEventDiscriminators!(this.options.batchSize);
      processed += result.processed;
      batches += 1;
      complete = result.state === "complete";
      if (!result.remaining) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { processed, batches, complete };
  }

  private async classifyDeliveryDebt(cutoff: string, maxBatches: number): Promise<{ settled: number; released: number; deliveryRecoveriesClassified: number; projectionGapsClassified: number; batches: number }> {
    let settled = 0;
    let released = 0;
    let deliveryRecoveriesClassified = 0;
    let projectionGapsClassified = 0;
    let batches = 0;
    while (!this.stopping && batches < maxBatches) {
      const result = this.store.classifyHistoricalDeliveryDebt!(cutoff, this.options.batchSize);
      settled += result.settledProjectionGaps;
      released += result.releasedQuarantines;
      deliveryRecoveriesClassified += result.classifiedDeliveryRecoveries;
      projectionGapsClassified += result.classifiedProjectionGaps;
      batches += 1;
      const processed = result.settledProjectionGaps + result.releasedQuarantines + result.classifiedDeliveryRecoveries + result.classifiedProjectionGaps;
      if (processed < this.options.batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { settled, released, deliveryRecoveriesClassified, projectionGapsClassified, batches };
  }

  private async pruneKind(prune: (limit: number) => number, maxBatches: number): Promise<{ removed: number; batches: number }> {
    let removed = 0;
    let batches = 0;
    while (!this.stopping && batches < maxBatches) {
      const batch = prune(this.options.batchSize);
      removed += batch;
      batches += 1;
      if (batch < this.options.batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { removed, batches };
  }
}
