import { DurableObject } from "cloudflare:workers";
import {
  applyCheckoutOutcome,
  applyDecision,
  applyTenantReauth,
  assertSameTenant,
  cartFromInput,
  createPendingSpendRequest,
  defaultTenantConnection,
  editSpendCap,
  findLockedCartMismatch,
  isRetryOfDenied,
  maybeExpire,
  prepareHandoff,
  refreshTenantConnection,
  SpendError,
} from "./logic.ts";
import type { RequestSpendInput } from "./schemas.ts";
import type {
  ChallengeInfo,
  CheckoutHandoffResult,
  CheckoutOutcome,
  SpendDecision,
  SpendRequest,
  TenantConnection,
} from "./types.ts";

const INDEX_KEY = "index:ids";
const TENANT_KEY = "tenant:connection";

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

      const nextCart = cartFromInput(input);
      const sameLock = existing.find(
        (record) =>
          (record.status === "APPROVED" ||
            record.status === "WAITING_FOR_YOU" ||
            record.status === "CHALLENGE") &&
          !findLockedCartMismatch([record], nextCart),
      );
      if (sameLock) {
        throw new SpendError(
          `Cart already locked on ${sameLock.spendRequestId} (${sameLock.status}). ` +
            "Use prepare_checkout_handoff. The agent cannot self-approve.",
        );
      }
      const mismatch = findLockedCartMismatch(existing, nextCart);
      const request = createPendingSpendRequest(input, tenantId, {
        supersededSpendRequestId: mismatch?.request.spendRequestId,
        cartDiff: mismatch?.diff,
      });
      await this.ctx.storage.put(request.spendRequestId, request);
      const ids = await this.readIndex();
      ids.push(request.spendRequestId);
      await this.writeIndex(ids);
      return ok(request);
    } catch (error) {
      return fail(error);
    }
  }

  async getTenantConnection(tenantId: string): Promise<TenantConnection> {
    const stored =
      (await this.ctx.storage.get<TenantConnection>(TENANT_KEY)) ??
      defaultTenantConnection(tenantId);
    const current = refreshTenantConnection(stored);
    if (current !== stored) {
      await this.ctx.storage.put(TENANT_KEY, current);
    }
    return current;
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
      const tenant = await this.getTenantConnection(tenantId);
      let current = maybeExpire(stored);
      current = applyTenantReauth(current, tenant);
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

  async editCap(
    spendRequestId: string,
    tenantId: string,
    spendCap: number,
  ): Promise<StoreResult<SpendRequest>> {
    try {
      const current = unwrapStore(
        await this.getForTenant(spendRequestId, tenantId),
      );
      const next = editSpendCap(current, spendCap);
      await this.ctx.storage.put(spendRequestId, next);
      return ok(next);
    } catch (error) {
      return fail(error);
    }
  }

  async reportOutcome(
    spendRequestId: string,
    tenantId: string,
    outcome: CheckoutOutcome,
    opts: { challengeKind?: ChallengeInfo["kind"]; orderId?: string } = {},
  ): Promise<StoreResult<SpendRequest>> {
    try {
      const current = unwrapStore(
        await this.getForTenant(spendRequestId, tenantId),
      );
      const next = applyCheckoutOutcome(current, outcome, opts);
      await this.ctx.storage.put(spendRequestId, next);
      return ok(next);
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
