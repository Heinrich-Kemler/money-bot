import { DurableObject } from "cloudflare:workers";
import {
  applyDecision,
  assertSameTenant,
  createPendingSpendRequest,
  isRetryOfDenied,
  maybeExpire,
  prepareHandoff,
  SpendError,
} from "./logic.ts";
import type { RequestSpendInput } from "./schemas.ts";
import type {
  CheckoutHandoffResult,
  SpendDecision,
  SpendRequest,
} from "./types.ts";

const INDEX_KEY = "index:ids";

export type StoreResult<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

function fail<T>(error: unknown): StoreResult<T> {
  const message =
    error instanceof Error ? error.message : "Unknown spend store error.";
  return { ok: false, error: message };
}

export function unwrapStore<T>(result: StoreResult<T>): T {
  if (!result.ok) {
    throw new SpendError(result.error);
  }
  return result.value;
}

export class SpendStore extends DurableObject<Env> {
  private async readIndex(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(INDEX_KEY)) ?? [];
  }

  private async writeIndex(ids: string[]): Promise<void> {
    await this.ctx.storage.put(INDEX_KEY, ids);
  }

  async createFromInput(
    input: RequestSpendInput,
    tenantId: string,
  ): Promise<StoreResult<SpendRequest>> {
    try {
      const existing = await this.listAll();
      const retry = isRetryOfDenied(existing, {
        merchantUrl: input.merchantUrl,
        amount: input.amount,
        currency: input.currency,
      });
      if (retry) {
        throw new SpendError(
          `Deny is final for ${retry.spendRequestId}. Do not retry the same merchant, amount, and currency.`,
        );
      }

      const request = createPendingSpendRequest(input, tenantId);
      await this.ctx.storage.put(request.spendRequestId, request);
      const ids = await this.readIndex();
      ids.push(request.spendRequestId);
      await this.writeIndex(ids);
      return ok(request);
    } catch (error) {
      return fail(error);
    }
  }

  async getForTenant(
    spendRequestId: string,
    tenantId: string,
  ): Promise<StoreResult<SpendRequest>> {
    try {
      const stored = await this.ctx.storage.get<SpendRequest>(spendRequestId);
      if (!stored) {
        throw new SpendError("Spend request not found.");
      }
      assertSameTenant(stored, tenantId);
      const current = maybeExpire(stored);
      if (current !== stored) {
        await this.ctx.storage.put(spendRequestId, current);
      }
      return ok(current);
    } catch (error) {
      return fail(error);
    }
  }

  async decide(
    spendRequestId: string,
    tenantId: string,
    decision: SpendDecision,
    opts: { decidedBy?: string; denyReason?: string; orderId?: string } = {},
  ): Promise<StoreResult<SpendRequest>> {
    try {
      const current = unwrapStore(await this.getForTenant(spendRequestId, tenantId));
      const next = applyDecision(current, decision, opts);
      await this.ctx.storage.put(spendRequestId, next);
      return ok(next);
    } catch (error) {
      return fail(error);
    }
  }

  async handoff(
    spendRequestId: string,
    tenantId: string,
  ): Promise<StoreResult<CheckoutHandoffResult>> {
    try {
      const current = unwrapStore(await this.getForTenant(spendRequestId, tenantId));
      const { request, result } = prepareHandoff(current);
      await this.ctx.storage.put(spendRequestId, request);
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  }

  private async listAll(): Promise<SpendRequest[]> {
    const ids = await this.readIndex();
    const records: SpendRequest[] = [];
    for (const id of ids) {
      const record = await this.ctx.storage.get<SpendRequest>(id);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }
}

export function spendStoreForTenant(
  env: Env,
  tenantId: string,
): DurableObjectStub<SpendStore> {
  const id = env.SPEND_STORE.idFromName(`tenant:${tenantId}`);
  return env.SPEND_STORE.get(id);
}
