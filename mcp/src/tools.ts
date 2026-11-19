import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, apiUrl, assertTronAddress, requestJson, type ApiSettings, type FetchLike } from "./api.js";

export type ToolSettings = ApiSettings & {
  /**
   * fetch that pays x402 challenges with USDC on Base. Present only when the
   * operator configured a wallet; it enforces the per-payment spending cap.
   */
  payingFetch?: FetchLike;
  maxPaymentUsd: string;
  decodePaymentResponse?: (header: string) => unknown;
};

type PublicRate = {
  energy_amount: number;
  duration_seconds: number;
  price_trx: string;
  average_commission_trx: string;
  savings_percent: string;
  observed_at?: string;
};

type PublicPrices = {
  rates: PublicRate[];
  trx_usd?: { price_usd: string; observed_at: string };
};

type X402Rental = {
  quote_id: string;
  status: string;
  target_address: string;
  energy_amount: number;
  duration_seconds: number;
  price_trx: string;
  price_usdc: string;
  valid_until: string;
  payment: unknown;
  operation: unknown;
  error_code: string | null;
};

const energyAmount = z
  .number()
  .int()
  .min(64_000)
  .max(200_000_000)
  .default(65_000)
  .describe("Energy to rent. 65,000 fits a USDT transfer to a wallet that already holds USDT; use 130,000 for a wallet with no USDT.");
const durationSeconds = z
  .union([z.literal(3_600), z.literal(86_400)])
  .default(3_600)
  .describe("Rental length in seconds: 3600 (1 hour) or 86400 (1 day).");
const tronAddress = (description: string) =>
  z.string().length(34).describe(description);

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof ApiError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await work());
  } catch (error) {
    return failure(error);
  }
}

/** 2 decimal USD reference; TRX remains the price of record. */
function usdReference(trx: string, trxUsd: string | undefined): string | null {
  const trxValue = Number(trx);
  const rate = Number(trxUsd);
  if (!Number.isFinite(trxValue) || !Number.isFinite(rate) || rate <= 0) return null;
  return `~$${(trxValue * rate).toFixed(2)}`;
}

export function registerTools(server: McpServer, settings: ToolSettings): void {
  server.registerTool(
    "get_energy_prices",
    {
      title: "Get TRON Energy rental prices",
      description:
        "Live TronEnergyFrog prices for 65,000 and 130,000 TRON Energy, for 1 hour or 1 day, compared with the TRX the network would burn without Energy. No API key needed.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(async () => {
      const { body } = await requestJson<PublicPrices>(
        settings,
        new URL("/public-prices.json", settings.siteBase).toString(),
      );
      return {
        currency: "TRX",
        trx_usd: body.trx_usd?.price_usd ?? null,
        rates: body.rates.map((rate) => ({
          energy_amount: rate.energy_amount,
          duration_seconds: rate.duration_seconds,
          price_trx: rate.price_trx,
          price_usd_reference: usdReference(rate.price_trx, body.trx_usd?.price_usd),
          trx_burned_without_energy: rate.average_commission_trx,
          savings_percent: rate.savings_percent,
          observed_at: rate.observed_at ?? null,
        })),
        note: "Prices change through the day. A quote locks the price before you pay.",
        rent_url: "https://tronenergyfrog.com/",
      };
    }),
  );

  server.registerTool(
    "create_x402_quote",
    {
      title: "Quote a TRON Energy rental payable with x402",
      description:
        "Locks a TRON Energy rental price for 10 minutes, payable in USDC on Base (or Solana) through x402. No account or API key. Energy is delegated to target_address, which must be the wallet that will SEND the USDT. Creating a quote costs nothing.",
      inputSchema: {
        target_address: tronAddress("TRON wallet that will send the USDT and should receive the Energy."),
        energy_amount: energyAmount,
        duration_seconds: durationSeconds,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ target_address, energy_amount, duration_seconds }) => run(async () => {
      assertTronAddress(target_address, "target_address");
      const { body } = await requestJson<X402Rental>(settings, apiUrl(settings, "/v1/x402/quotes"), {
        method: "POST",
        body: JSON.stringify({ target_address, energy_amount, duration_seconds }),
      });
      return {
        ...body,
        how_to_pay: settings.payingFetch
          ? `Call pay_x402_quote with this quote_id before ${body.valid_until}. Payments above ${settings.maxPaymentUsd} are refused.`
          : `POST ${apiUrl(settings, `/v1/x402/rentals/${body.quote_id}`)} with an x402 v2 client (USDC on Base or Solana). This MCP server pays automatically only when TRONENERGYFROG_EVM_PRIVATE_KEY is set.`,
      };
    }),
  );

  if (settings.payingFetch) {
    const payingFetch = settings.payingFetch;
    server.registerTool(
      "pay_x402_quote",
      {
        title: "Pay an x402 Energy quote with USDC",
        description:
          `Pays an unexpired quote from create_x402_quote with USDC on Base from the configured wallet, then submits the rental. Spends real money: confirm the quote's price_usdc and target_address with the user first. Payments above ${settings.maxPaymentUsd} are refused.`,
        inputSchema: {
          quote_id: z.uuid().describe("quote_id returned by create_x402_quote."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      ({ quote_id }) => run(async () => {
        const url = apiUrl(settings, `/v1/x402/rentals/${quote_id}`);
        const current = await requestJson<X402Rental>(settings, url);
        if (current.body.status !== "payment_required") {
          return { message: "This quote does not need payment.", rental: current.body };
        }
        const { body, response } = await requestJson<X402Rental>(
          settings,
          url,
          { method: "POST", body: "{}" },
          payingFetch,
        );
        const header = response.headers.get("PAYMENT-RESPONSE");
        return {
          rental: body,
          settlement: header && settings.decodePaymentResponse
            ? settings.decodePaymentResponse(header)
            : null,
          next_step: "Poll get_x402_rental until status is succeeded.",
        };
      }),
    );
  }

  server.registerTool(
    "get_x402_rental",
    {
      title: "Get x402 rental status",
      description: "Payment and delivery status of an x402 quote: payment_required, settling, fulfillment_pending, succeeded, failed or expired.",
      inputSchema: { quote_id: z.uuid().describe("quote_id returned by create_x402_quote.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ quote_id }) => run(async () =>
      (await requestJson<X402Rental>(settings, apiUrl(settings, `/v1/x402/rentals/${quote_id}`))).body),
  );

  if (!settings.apiKey) return;

  server.registerTool(
    "get_account",
    {
      title: "Get TronEnergyFrog account",
      description: "Account balance in TRX, discount and API-key status for the configured API key.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(async () =>
      (await requestJson(settings, apiUrl(settings, "/v1/profile"), { authenticated: true })).body),
  );

  server.registerTool(
    "check_transfer_energy",
    {
      title: "Check Energy needed for a USDT transfer",
      description:
        "Checks whether the USDT RECIPIENT already holds USDT and estimates the Energy (65K or 130K) and TRX burn for sending USDT to it.",
      inputSchema: {
        recipient_address: tronAddress("TRON wallet that will RECEIVE the USDT."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ recipient_address }) => run(async () => {
      assertTronAddress(recipient_address, "recipient_address");
      return (await requestJson(
        settings,
        apiUrl(settings, `/v1/rates/network-fees/${recipient_address}`),
        { authenticated: true },
      )).body;
    }),
  );

  server.registerTool(
    "rent_energy",
    {
      title: "Rent TRON Energy from account balance",
      description:
        "Rents TRON Energy at the live price and pays from the account's TRX balance. Spends real money: confirm the address, amount and price with the user first. Reuse the same idempotency_key when retrying so the order is not placed twice.",
      inputSchema: {
        target_address: tronAddress("TRON wallet that will send the USDT and should receive the Energy."),
        energy_amount: energyAmount,
        duration_seconds: durationSeconds,
        project_id: z.string().regex(/^[A-Za-z0-9._:-]{1,50}$/).optional()
          .describe("Optional order reference of your own, for later lookup."),
        idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).optional()
          .describe("Retry key. Omit for a new order; repeat it to retry the same order safely."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ target_address, energy_amount, duration_seconds, project_id, idempotency_key }) => run(async () => {
      assertTronAddress(target_address, "target_address");
      const key = idempotency_key ?? `mcp-${randomUUID()}`;
      const { body } = await requestJson(settings, apiUrl(settings, "/v1/rental/auto"), {
        method: "POST",
        authenticated: true,
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({
          target_address,
          energy_amount,
          duration_seconds,
          ...(project_id ? { project_id } : {}),
        }),
      });
      return { idempotency_key: key, operation: body };
    }),
  );

  server.registerTool(
    "get_rental",
    {
      title: "Get an account rental",
      description: "Status of a rental placed with rent_energy, by its operation id.",
      inputSchema: { operation_id: z.uuid().describe("id returned by rent_energy.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ operation_id }) => run(async () =>
      (await requestJson(settings, apiUrl(settings, `/v1/operations/${operation_id}`), { authenticated: true })).body),
  );
}
