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
  ): Promise<SpendRequest> {
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
    return request;
  }

  async getForTenant(
    spendRequestId: string,
    tenantId: string,
  ): Promise<SpendRequest> {
    const stored = await this.ctx.storage.get<SpendRequest>(spendRequestId);
    if (!stored) {
      throw new SpendError("Spend request not found.");
    }
    assertSameTenant(stored, tenantId);
    const current = maybeExpire(stored);
    if (current !== stored) {
      await this.ctx.storage.put(spendRequestId, current);
    }
    return current;
  }

  async decide(
    spendRequestId: string,
    tenantId: string,
    decision: SpendDecision,
    opts: { decidedBy?: string; denyReason?: string; orderId?: string } = {},
  ): Promise<SpendRequest> {
    const current = await this.getForTenant(spendRequestId, tenantId);
    const next = applyDecision(current, decision, opts);
    await this.ctx.storage.put(spendRequestId, next);
    return next;
  }

  async handoff(
    spendRequestId: string,
    tenantId: string,
  ): Promise<CheckoutHandoffResult> {
    const current = await this.getForTenant(spendRequestId, tenantId);
    const { request, result } = prepareHandoff(current);
    await this.ctx.storage.put(spendRequestId, request);
    return result;
  }

  async markStatus(
    spendRequestId: string,
    tenantId: string,
    status: SpendRequest["status"],
    extras: Partial<Pick<SpendRequest, "orderId">> = {},
  ): Promise<SpendRequest> {
    const current = await this.getForTenant(spendRequestId, tenantId);
    const next: SpendRequest = {
      ...current,
      ...extras,
      status,
      updatedAt: new Date().toISOString(),
    };
    await this.ctx.storage.put(spendRequestId, next);
    return next;
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
